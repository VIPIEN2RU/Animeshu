#!/usr/bin/env node

import { MaxClient } from 'max-account-api';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execAsync = promisify(exec);

// ============== КОНФИГУРАЦИЯ ==============
const BASE_URL = 'https://anilibria.top';
const LATEST_URL = `${BASE_URL}/anime/releases/latest/`;
const SESSION_FILE = '.max-session.json';
const HISTORY_FILE = 'downloaded_releases.txt';
const TEMP_DIR = 'temp';

const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const SESSION_BASE64 = process.env.MAX_SESSION_BASE64;

// ============== ИСТОРИЯ ==============
class History {
  private sentIds: Set<string> = new Set();

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        this.sentIds = new Set(data.split('\n').filter(id => id.trim() !== ''));
        console.log(`📂 Загружено ${this.sentIds.size} записей`);
      }
    } catch (e) {
      console.warn('⚠️ Ошибка загрузки истории');
    }
  }

  isSent(id: string): boolean {
    return this.sentIds.has(id);
  }

  async markSent(id: string): Promise<void> {
    this.sentIds.add(id);
    await fsPromises.appendFile(this.filePath, id + '\n', 'utf-8');
  }
}

// ============== ПАРСЕР ==============
class AniLibertyParser {
  private readonly http = axios.create({
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 30000,
  });

  async fetchHtml(url: string): Promise<string> {
    const res = await this.http.get(url);
    return res.data;
  }

  getReleaseLinks(html: string): string[] {
    const $ = cheerio.load(html);
    const links: string[] = [];
    $('div.v-col-sm-4.v-col-md-3.v-col-lg-2.v-col-6 a.v-card').each((_, el) => {
      const href = $(el).attr('href');
      if (href) links.push(new URL(href, BASE_URL).href);
    });
    return links;
  }

  // ========== НОВОЕ: Парсинг связанных релизов ==========
  async getRelatedReleases(releaseUrl: string): Promise<string[]> {
    try {
      // Строим URL страницы связанных релизов
      const releaseId = releaseUrl.match(/\/release\/([^/]+)/)?.[1] || '';
      if (!releaseId) return [];
      
      const franchisesUrl = `${BASE_URL}/anime/releases/release/${releaseId}/franchises`;
      console.log(`   🔗 Парсинг связанных релизов: ${franchisesUrl}`);
      
      const html = await this.fetchHtml(franchisesUrl);
      const $ = cheerio.load(html);
      
      const relatedLinks: string[] = [];
      
      // Ищем все карточки релизов на странице связанных
      $('div.v-col-sm-4.v-col-md-3.v-col-lg-2.v-col-6 a.v-card').each((_, el) => {
        const href = $(el).attr('href');
        if (href) {
          const fullUrl = new URL(href, BASE_URL).href;
          // Исключаем сам релиз, чтобы избежать бесконечного цикла
          if (fullUrl !== releaseUrl) {
            relatedLinks.push(fullUrl);
          }
        }
      });
      
      console.log(`   📊 Найдено связанных релизов: ${relatedLinks.length}`);
      return relatedLinks;
      
    } catch (error) {
      console.error(`   ❌ Ошибка парсинга связанных релизов:`, error);
      return [];
    }
  }

  parseReleasePage(html: string, url: string): any {
    const $ = cheerio.load(html);
    const title = $('div.text-autosize.ff-heading').text().trim() || 'Неизвестно';
    const englishTitle = $('div.fz-70.ff-heading.text-grey-darken-2').text().trim();
    const description = $('div.fz-90.text-grey.ff-body.text-pre-wrap').text().trim();
    const poster = $('div.v-responsive.v-img img').attr('src') || '';
    const posterUrl = poster ? new URL(poster, BASE_URL).href : '';

    const metadata: Record<string, string> = {};
    $('div.fz-80.ff-body div.d-flex.align-center').each((_, el) => {
      const label = $(el).find('.text-grey-darken-1').text().replace(':', '').trim();
      const value = $(el).find('.text-truncate').text().trim();
      if (label && value) metadata[label] = value;
    });

    const episodes: { number: string; name: string; url: string }[] = [];
    $('.v-list-item a.v-list-item--link').each((_, el) => {
      const number = $(el).find('.v-list-item-title').text().trim();
      const name = $(el).find('.v-list-item-subtitle').text().trim();
      const href = $(el).attr('href');
      if (number && href) {
        episodes.push({ number, name, url: new URL(href, BASE_URL).href });
      }
    });

    // Проверяем наличие вкладки "Связанное"
    const hasRelated = $('a.v-tab[href*="/franchises"]').length > 0;

    const releaseId = url.match(/\/release\/([^/]+)/)?.[1] || '';
    
    return { 
      id: releaseId, 
      title, 
      englishTitle, 
      description, 
      poster: posterUrl, 
      metadata, 
      episodes, 
      episodeCount: episodes.length,
      hasRelated  // Флаг, что есть связанные релизы
    };
  }

  async getEpisodeVideoUrl(episodeUrl: string): Promise<string | null> {
    const html = await this.fetchHtml(episodeUrl);
    const m3u8Pattern = /https?:\/\/[^\s"']+\.m3u8[^\s"']*/g;
    const matches = html.match(m3u8Pattern);
    if (!matches) return null;
    const preferred = matches.find(u => u.includes('720') || u.includes('720p'));
    return preferred || matches[0];
  }
}

// ============== КЛИЕНТ MAX ==============
class MaxClientWrapper {
  private client: MaxClient | null = null;
  private chatId: string | null = null;

  async login(): Promise<void> {
    if (SESSION_BASE64) {
      const json = Buffer.from(SESSION_BASE64, 'base64').toString('utf-8');
      await fsPromises.writeFile(SESSION_FILE, json, 'utf-8');
      console.log('🔑 Сессия восстановлена');
    }

    try {
      await fsPromises.access(SESSION_FILE);
      console.log('📂 Используем сохранённую сессию');
      this.client = new MaxClient({ sessionFile: SESSION_FILE });
      await this.client.connect();
      try {
        await this.client.getMe();
        console.log('✅ Сессия активна');
      } catch {
        console.log('⚠️ Сессия истекла');
        await this.doInteractiveLogin();
      }
    } catch {
      console.log('🆕 Создаём новую сессию');
      await this.doInteractiveLogin();
    }

    const dialogs = await this.client!.getDialogs();
    const fav = dialogs.find((d: any) => d.title === 'Избранное' || d.isSelf);
    if (!fav) throw new Error('Чат "Избранное" не найден');
    this.chatId = fav.id;
    console.log(`📨 Чат "Избранное" найден`);
  }

  private async doInteractiveLogin(): Promise<void> {
    const readline = (await import('readline')).default;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

    try {
      const phone = await question('📱 Телефон (+79991234567): ');
      const client = await MaxClient.loginWithPhone({
        phone,
        getSmsCode: () => question('🔑 SMS-код: '),
        getPassword: (challenge: any) => question(`🔐 2FA (${challenge.hint}): `),
        sessionFile: SESSION_FILE,
      });
      this.client = client;
      console.log('✅ Авторизация успешна');
    } finally {
      rl.close();
    }
  }

  async sendVideo(videoPath: string, caption: string): Promise<void> {
    if (!this.client || !this.chatId) throw new Error('Клиент не инициализирован');
    const data = await fsPromises.readFile(videoPath);
    const filename = path.basename(videoPath);
    await this.client.sendVideo(this.chatId, { data, filename }, caption);
    console.log(`   📤 Видео отправлено`);
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.client || !this.chatId) throw new Error('Клиент не инициализирован');
    await this.client.sendMessage(this.chatId, text);
  }
}

// ============== ЗАГРУЗЧИК ==============
async function downloadVideo(m3u8Url: string, outputPath: string): Promise<void> {
  const cmd = `ffmpeg -i "${m3u8Url}" -c copy -bsf:a aac_adtstoasc -y "${outputPath}"`;
  console.log(`   📥 Загрузка видео...`);
  const { stderr } = await execAsync(cmd);
  if (stderr) console.warn('   ⚠️', stderr);
  console.log(`   ✅ Видео сохранено`);
}

// ============== ОБРАБОТЧИК РЕЛИЗА (РЕКУРСИВНЫЙ) ==============
async function processRelease(
  parser: AniLibertyParser,
  max: MaxClientWrapper,
  history: History,
  link: string,
  depth: number = 0,
  visited: Set<string> = new Set()
): Promise<number> {
  const indent = '  '.repeat(depth);
  let sentEpisodes = 0;

  // Защита от бесконечной рекурсии
  if (visited.has(link)) {
    console.log(`${indent}⏭️ Уже обрабатывался: ${link}`);
    return 0;
  }
  visited.add(link);

  // Ограничение глубины рекурсии
  if (depth > 5) {
    console.log(`${indent}⚠️ Достигнута максимальная глубина рекурсии`);
    return 0;
  }

  try {
    console.log(`${indent}🔄 ${link}`);
    const releaseHtml = await parser.fetchHtml(link);
    const release = parser.parseReleasePage(releaseHtml, link);

    if (history.isSent(release.id)) {
      console.log(`${indent}   ⏭️ Уже отправлено: ${release.title}`);
      return 0;
    }

    console.log(`${indent}   ✨ НОВЫЙ РЕЛИЗ: ${release.title}`);
    console.log(`${indent}   📀 Эпизодов: ${release.episodeCount}`);

    // Отправляем информацию о релизе
    const info = `
<b>🎬 ${release.title}</b>
<i>${release.englishTitle || ''}</i>
📅 ${release.metadata['Год выхода'] || 'Не указан'}
📺 ${release.metadata['Тип'] || 'Не указан'}
📀 Эпизодов: ${release.episodeCount}

📝 ${release.description.slice(0, 300)}...
`;
    await max.sendMessage(info.trim());

    // Обрабатываем эпизоды
    for (const episode of release.episodes) {
      console.log(`${indent}   📺 Эпизод ${episode.number}: ${episode.name}`);
      const videoUrl = await parser.getEpisodeVideoUrl(episode.url);
      if (!videoUrl) {
        console.log(`${indent}   ⚠️ Видео не найдено`);
        continue;
      }

      const tempFile = path.join(TEMP_DIR, `${release.id}_ep${episode.number}.mp4`);
      await fsPromises.mkdir(TEMP_DIR, { recursive: true });
      try {
        await downloadVideo(videoUrl, tempFile);
        await max.sendVideo(tempFile, `${release.title} - Эпизод ${episode.number}`);
        sentEpisodes++;
        await fsPromises.unlink(tempFile).catch(() => {});
      } catch (err) {
        console.error(`${indent}   ❌ Ошибка:`, err);
        await fsPromises.unlink(tempFile).catch(() => {});
      }
    }

    if (sentEpisodes > 0) {
      await history.markSent(release.id);
      console.log(`${indent}   ✅ Релиз "${release.title}" обработан (${sentEpisodes} эп.)`);
    }

    // ========== НОВОЕ: Обработка связанных релизов ==========
    // Проверяем наличие вкладки "Связанное" и парсим её
    if (release.hasRelated && depth < 5) {
      console.log(`${indent}   🔗 Проверка связанных релизов...`);
      
      const relatedLinks = await parser.getRelatedReleases(link);
      
      if (relatedLinks.length > 0) {
        console.log(`${indent}   📊 Найдено ${relatedLinks.length} связанных релизов`);
        
        for (const relatedLink of relatedLinks) {
          // Рекурсивно обрабатываем каждый связанный релиз
          const relatedSent = await processRelease(
            parser, 
            max, 
            history, 
            relatedLink, 
            depth + 1,
            visited
          );
          sentEpisodes += relatedSent;
        }
      }
    }

  } catch (error) {
    console.error(`${indent}   ❌ Ошибка обработки релиза:`, error);
  }

  return sentEpisodes;
}

// ============== MAIN ==============
async function main() {
  console.log('🚀 AniLiberty → MAX');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log(`🔄 Окружение: ${IS_GITHUB_ACTIONS ? 'GitHub Actions' : 'локальное'}`);

  const history = new History(HISTORY_FILE);
  const parser = new AniLibertyParser();
  const max = new MaxClientWrapper();

  await max.login();

  console.log('\n📡 Парсинг главной страницы новинок...');
  const html = await parser.fetchHtml(LATEST_URL);
  const releaseLinks = parser.getReleaseLinks(html);
  console.log(`📊 Найдено релизов: ${releaseLinks.length}`);

  let totalNewReleases = 0;
  const visited = new Set<string>();

  for (const link of releaseLinks) {
    const sent = await processRelease(parser, max, history, link, 0, visited);
    if (sent > 0) totalNewReleases++;
  }

  // Очистка временной папки
  try {
    await fsPromises.rmdir(TEMP_DIR, { recursive: true }).catch(() => {});
  } catch {}

  console.log('\n🎉 Готово!');
  console.log(`📊 Новых релизов (включая связанные): ${totalNewReleases}`);
}

main().catch((err) => {
  console.error('❌ Ошибка:', err);
  process.exit(1);
});
