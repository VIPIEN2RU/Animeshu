#!/usr/bin/env python3
"""
Скрипт для парсинга новинок AniLiberty и прямой отправки видео в MAX
БЕЗ сохранения на диск, БЕЗ артефактов, БЕЗ временных файлов
"""

import os
import sys
import json
import asyncio
import re
from datetime import datetime
from typing import Optional, Dict, List, Set
from urllib.parse import urljoin

# Импорты
import aiohttp
from bs4 import BeautifulSoup
from max_account_api import MaxClient

# ============== КОНФИГУРАЦИЯ ==============
BASE_URL = "https://anilibria.top"
LATEST_URL = f"{BASE_URL}/anime/releases/latest/"
SESSION_FILE = ".max-session.json"
HISTORY_FILE = "downloaded_releases.txt"

# Номер телефона из секретов GitHub
PHONE_NUMBER = os.getenv('MAX_PHONE', '79511511643')
IS_GITHUB_ACTIONS = os.getenv('GITHUB_ACTIONS') == 'true'


# ============== РАБОТА С ИСТОРИЕЙ ==============
class DownloadHistory:
    """Управляет историей отправленных релизов (только ID)"""
    
    def __init__(self, history_file: str = HISTORY_FILE):
        self.history_file = history_file
        self.downloaded_ids: Set[str] = set()
        self.load()
    
    def load(self):
        try:
            if os.path.exists(self.history_file):
                with open(self.history_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#'):
                            self.downloaded_ids.add(line)
                print(f"📂 Загружено {len(self.downloaded_ids)} записей")
        except Exception as e:
            print(f"⚠️ Ошибка загрузки истории: {e}")
    
    def is_sent(self, release_id: str) -> bool:
        return release_id in self.downloaded_ids
    
    def add_record(self, release_id: str):
        self.downloaded_ids.add(release_id)
        try:
            with open(self.history_file, 'a', encoding='utf-8') as f:
                f.write(f"{release_id}\n")
        except Exception as e:
            print(f"⚠️ Ошибка сохранения: {e}")


# ============== ПАРСЕР ANILIBERTIA ==============
class AniLibertyParser:
    """Парсер сайта AniLiberty"""
    
    def __init__(self):
        self.session = None
    
    async def __aenter__(self):
        self.session = aiohttp.ClientSession(
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
            },
            timeout=aiohttp.ClientTimeout(total=60)
        )
        return self
    
    async def __aexit__(self, *args):
        if self.session:
            await self.session.close()
    
    async def fetch_html(self, url: str) -> str:
        async with self.session.get(url) as response:
            response.raise_for_status()
            return await response.text()
    
    def parse_release_links(self, html: str) -> List[str]:
        """Извлекает ссылки на релизы"""
        soup = BeautifulSoup(html, 'html.parser')
        links = []
        
        for card in soup.select('div.v-col-sm-4.v-col-md-3.v-col-lg-2.v-col-6 a.v-card'):
            href = card.get('href')
            if href:
                links.append(urljoin(BASE_URL, href))
        
        return links
    
    def parse_release_page(self, html: str, url: str) -> Dict:
        """Парсит страницу релиза"""
        soup = BeautifulSoup(html, 'html.parser')
        
        # Название
        title_elem = soup.select_one('div.text-autosize.ff-heading')
        title = title_elem.text.strip() if title_elem else "Неизвестно"
        
        # Английское название
        eng_title_elem = soup.select_one('div.fz-70.ff-heading.text-grey-darken-2')
        english_title = eng_title_elem.text.strip() if eng_title_elem else ""
        
        # Описание
        desc_elem = soup.select_one('div.fz-90.text-grey.ff-body.text-pre-wrap')
        description = desc_elem.text.strip() if desc_elem else ""
        
        # Постер
        poster_elem = soup.select_one('div.v-responsive.v-img img')
        poster = poster_elem.get('src') if poster_elem else ""
        if poster and not poster.startswith('http'):
            poster = urljoin(BASE_URL, poster)
        
        # Метаданные
        metadata = {}
        for block in soup.select('div.fz-80.ff-body div.d-flex.align-center'):
            label_elem = block.select_one('.text-grey-darken-1')
            value_elem = block.select_one('.text-truncate')
            if label_elem and value_elem:
                label = label_elem.text.replace(':', '').strip()
                value = value_elem.text.strip()
                metadata[label] = value
        
        # Эпизоды - ищем ссылки
        episodes = []
        for item in soup.select('.v-list-item a.v-list-item--link'):
            number_elem = item.select_one('.v-list-item-title')
            name_elem = item.select_one('.v-list-item-subtitle')
            href = item.get('href')
            
            if number_elem and href:
                episodes.append({
                    'number': number_elem.text.strip(),
                    'name': name_elem.text.strip() if name_elem else "",
                    'url': urljoin(BASE_URL, href)
                })
        
        # ID релиза
        release_id = re.search(r'/release/([^/]+)', url)
        release_id = release_id.group(1) if release_id else ""
        
        return {
            'id': release_id,
            'url': url,
            'title': title,
            'english_title': english_title,
            'description': description,
            'poster': poster,
            'metadata': metadata,
            'episodes': episodes,
            'episode_count': len(episodes)
        }
    
    async def get_episode_video_url(self, episode_url: str) -> Optional[str]:
        """Извлекает прямую ссылку на видео (m3u8) из страницы эпизода"""
        try:
            html = await self.fetch_html(episode_url)
            
            # Ищем m3u8 ссылки
            m3u8_pattern = r'https?://[^\s"\']+\.m3u8[^\s"\']*'
            matches = re.findall(m3u8_pattern, html)
            
            # Сортируем по качеству: сначала 720p
            for match in matches:
                if '720' in match or '720p' in match:
                    return match
            
            # Если нет 720p, берём первую ссылку
            if matches:
                return matches[0]
            
            return None
            
        except Exception as e:
            print(f"⚠️ Ошибка получения видео URL: {e}")
            return None


# ============== КЛИЕНТ MAX ==============
class MaxMessenger:
    """Клиент для отправки в MAX"""
    
    def __init__(self):
        self.client = None
    
    async def connect(self) -> bool:
        try:
            self.client = MaxClient(session_file=SESSION_FILE)
            await self.client.connect()
            return True
        except Exception as e:
            print(f"❌ Ошибка подключения: {e}")
            return False
    
    async def get_favorites_chat_id(self) -> Optional[str]:
        try:
            dialogs = await self.client.get_dialogs()
            for dialog in dialogs:
                if dialog.get('is_favorite', False) or dialog.get('title') == "Избранное":
                    return dialog.get('id')
            return None
        except Exception as e:
            print(f"⚠️ Ошибка поиска чата: {e}")
            return None
    
    async def send_message(self, chat_id: str, text: str) -> bool:
        try:
            await self.client.send_message(chat_id, text)
            return True
        except Exception as e:
            print(f"❌ Ошибка отправки: {e}")
            return False
    
    async def send_video_stream(self, chat_id: str, video_url: str, caption: str) -> bool:
        """Отправляет видео в MAX потоком (прямая загрузка)"""
        try:
            # Используем aiohttp для стриминга
            async with aiohttp.ClientSession() as session:
                async with session.get(video_url) as response:
                    if response.status != 200:
                        print(f"   ⚠️ Ошибка загрузки видео: {response.status}")
                        return False
                    
                    # Получаем размер файла для прогресса
                    total_size = int(response.headers.get('content-length', 0))
                    downloaded = 0
                    
                    print(f"   📥 Загрузка видео ({total_size // (1024*1024)} MB)...")
                    
                    # Читаем и отправляем по частям
                    chunk_size = 1024 * 1024  # 1MB
                    last_progress = 0
                    
                    # Создаём временный буфер в памяти
                    video_data = bytearray()
                    
                    async for chunk in response.content.iter_chunked(chunk_size):
                        video_data.extend(chunk)
                        downloaded += len(chunk)
                        
                        if total_size > 0:
                            progress = int((downloaded / total_size) * 100)
                            if progress >= last_progress + 10:
                                print(f"   📊 Прогресс: {progress}%", end='')
                                last_progress = progress
                    
                    print()  # Новая строка после прогресса
                    
                    # Проверяем размер в памяти (MAX лимит ~2GB)
                    size_mb = len(video_data) / (1024 * 1024)
                    if size_mb > 2000:
                        print(f"   ⚠️ Видео слишком большое ({size_mb:.1f} MB) для отправки в MAX")
                        return False
                    
                    print(f"   📤 Отправка видео в MAX ({size_mb:.1f} MB)...")
                    
                    # Отправляем через API MAX (поддерживает bytes)
                    # Используем метод send_file с bytes
                    await self.client.send_file(
                        chat_id, 
                        video_data, 
                        caption=caption,
                        filename=f"episode.mp4"
                    )
                    
                    return True
                    
        except Exception as e:
            print(f"❌ Ошибка отправки видео: {e}")
            return False


# ============== ОСНОВНАЯ ЛОГИКА ==============
async def main():
    """Главная функция"""
    print("=" * 60)
    print("  🚀 ANILIBERTIA → MAX ПРЯМОЙ СТРИМИНГ")
    print("=" * 60)
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"📱 Номер: {PHONE_NUMBER}")
    print(f"🔄 Окружение: {'GitHub Actions' if IS_GITHUB_ACTIONS else 'Локальное'}")
    print("=" * 60)
    
    # 1. История отправленных релизов
    history = DownloadHistory()
    
    # 2. Подключение к MAX
    print("\n🔐 Подключение к MAX...")
    
    # Проверяем сессию
    if not os.path.exists(SESSION_FILE) and not IS_GITHUB_ACTIONS:
        print("📱 Создание новой сессии...")
        try:
            client = MaxClient(phone=PHONE_NUMBER, session_file=SESSION_FILE)
            await client.connect()
            print("✅ Сессия создана!")
        except Exception as e:
            print(f"❌ Ошибка создания сессии: {e}")
            print("💡 Возможно, требуется SMS-код. Запустите локально для авторизации.")
            return
    else:
        print("📂 Использование сохранённой сессии")
    
    max_client = MaxMessenger()
    if not await max_client.connect():
        print("❌ Не удалось подключиться к MAX")
        return
    
    chat_id = await max_client.get_favorites_chat_id()
    if not chat_id:
        print("❌ Чат 'Избранное' не найден")
        return
    
    print(f"✅ Подключено к MAX")
    
    # 3. Парсинг AniLiberty
    print("\n📡 Парсинг AniLiberty...")
    
    async with AniLibertyParser() as parser:
        try:
            html = await parser.fetch_html(LATEST_URL)
            release_links = parser.parse_release_links(html)
            print(f"📊 Найдено релизов: {len(release_links)}")
        except Exception as e:
            print(f"❌ Ошибка загрузки: {e}")
            return
        
        # Обрабатываем каждый релиз
        new_releases = 0
        for idx, link in enumerate(release_links, 1):
            print(f"\n🔄 {idx}/{len(release_links)}")
            
            try:
                html = await parser.fetch_html(link)
                data = parser.parse_release_page(html, link)
                
                # Проверяем, отправлен ли уже
                if history.is_sent(data['id']):
                    print(f"   ⏭️ Уже отправлено: {data['title']}")
                    continue
                
                print(f"   ✨ НОВЫЙ РЕЛИЗ: {data['title']}")
                print(f"   📀 Эпизодов: {data['episode_count']}")
                
                # Отправляем информацию о релизе
                info_message = f"""🎬 {data['title']}
📌 {data['english_title']}
📅 {data['metadata'].get('Год выхода', 'Не указан')}
📺 {data['metadata'].get('Тип', 'Не указан')}
📀 Эпизодов: {data['episode_count']}

📝 {data['description'][:300]}...
"""
                await max_client.send_message(chat_id, info_message)
                
                # Отправляем каждый эпизод
                sent_episodes = 0
                for episode in data['episodes']:
                    print(f"\n   📺 Эпизод {episode['number']}: {episode['name']}")
                    
                    # Получаем ссылку на видео
                    video_url = await parser.get_episode_video_url(episode['url'])
                    if not video_url:
                        print(f"   ⚠️ Не найден видео URL")
                        continue
                    
                    # Отправляем видео потоком
                    caption = f"{data['title']} - Эпизод {episode['number']}: {episode['name']}"
                    success = await max_client.send_video_stream(chat_id, video_url, caption)
                    
                    if success:
                        sent_episodes += 1
                        print(f"   ✅ Отправлен эпизод {episode['number']}")
                    else:
                        print(f"   ❌ Ошибка отправки эпизода {episode['number']}")
                    
                    # Задержка между отправками
                    await asyncio.sleep(2)
                
                # Отмечаем релиз как отправленный
                if sent_episodes > 0:
                    history.add_record(data['id'])
                    new_releases += 1
                    print(f"\n   ✅ Релиз '{data['title']}' отправлен ({sent_episodes} эпизодов)")
                
            except Exception as e:
                print(f"   ❌ Ошибка: {e}")
                continue
    
    # 4. Завершение
    print("\n" + "=" * 60)
    print(f"🎉 ГОТОВО!")
    print(f"📊 Новых релизов: {new_releases}")
    print(f"📂 История: {HISTORY_FILE}")
    print("=" * 60)


# ============== ТОЧКА ВХОДА ==============
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ Прервано пользователем")
    except Exception as e:
        print(f"❌ Критическая ошибка: {e}")
        sys.exit(1)
