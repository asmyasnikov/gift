// Утилита для кэширования изображений
// Использует IndexedDB для персистентного хранения и Map для быстрого доступа в памяти

class ImageCache {
  constructor() {
    this.memoryCache = new Map(); // Кэш в памяти для быстрого доступа
    this.dbName = 'tileImageCache';
    this.storeName = 'images';
    this.db = null;
    this.initPromise = null;
  }

  // Инициализация IndexedDB
  async init() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      // Проверяем поддержку IndexedDB
      if (!window.indexedDB) {
        console.warn('IndexedDB не поддерживается, используется только кэш в памяти');
        resolve(false);
        return;
      }

      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        console.warn('Ошибка открытия IndexedDB, используется только кэш в памяти:', request.error);
        resolve(false);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(true);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
    });

    return this.initPromise;
  }

  // Получить изображение из кэша
  async get(url) {
    // Сначала проверяем кэш в памяти
    if (this.memoryCache.has(url)) {
      return this.memoryCache.get(url);
    }

    // Затем проверяем IndexedDB
    await this.init();
    if (!this.db) {
      return null;
    }

    try {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(url);

      return new Promise((resolve) => {
        request.onsuccess = () => {
          const blob = request.result;
          if (blob) {
            // Создаем URL из blob и сохраняем в памяти
            const objectUrl = URL.createObjectURL(blob);
            this.memoryCache.set(url, objectUrl);
            resolve(objectUrl);
          } else {
            resolve(null);
          }
        };

        request.onerror = () => {
          resolve(null);
        };
      });
    } catch (error) {
      console.warn('Ошибка чтения из IndexedDB:', error);
      return null;
    }
  }

  // Сохранить изображение в кэш
  async set(url, blob) {
    // Сохраняем в памяти
    const objectUrl = URL.createObjectURL(blob);
    this.memoryCache.set(url, objectUrl);

    // Сохраняем в IndexedDB
    await this.init();
    if (!this.db) {
      return;
    }

    try {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      store.put(blob, url);
    } catch (error) {
      console.warn('Ошибка записи в IndexedDB:', error);
    }
  }

  // Проверить существование файла на сервере
  async checkFileExists(url) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 секунды таймаут для проверки
      
      const response = await fetch(url, {
        method: 'HEAD', // Используем HEAD для проверки без загрузки всего файла
        signal: controller.signal,
        cache: 'no-cache' // Отключаем кэш браузера для проверки
      });
      
      clearTimeout(timeoutId);
      return response.ok; // Файл существует если статус 200-299
    } catch (error) {
      // Если ошибка сети, считаем что файл не существует
      return false;
    }
  }

  // Загрузить изображение с кэшированием
  // Всегда проверяет существование файла на сервере перед использованием кэша
  async loadImage(url) {
    // Сначала проверяем существование файла на сервере
    const fileExists = await this.checkFileExists(url);
    
    if (!fileExists) {
      // Файл не существует - удаляем из кэша если был там
      await this.remove(url);
      return null;
    }

    // Файл существует - проверяем кэш (сначала память, потом IndexedDB)
    const cachedUrl = await this.get(url);
    if (cachedUrl) {
      return cachedUrl;
    }

    // Если в кэше нет, загружаем из сети
    try {
      // Создаем AbortController для таймаута (более совместимо)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 секунд таймаут
      
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-cache' // Отключаем кэш браузера
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // Если сервер вернул ошибку, но не network error, это нормально
        console.warn(`HTTP error при загрузке ${url}: status ${response.status}`);
        return null;
      }
      const blob = await response.blob();
      
      // Сохраняем в кэш
      await this.set(url, blob);
      
      // Возвращаем URL из кэша
      return await this.get(url);
    } catch (error) {
      // Если это network error (сервер недоступен), просто возвращаем null
      // Не выбрасываем ошибку, чтобы не ломать приложение
      if (error.name === 'AbortError' || error.name === 'TypeError' || 
          error.message.includes('Failed to fetch') || 
          error.message.includes('NetworkError') ||
          error.message.includes('Network request failed')) {
        // Сервер недоступен - это нормально, используем только кэш
        // Не логируем как ошибку, чтобы не засорять консоль
        return null;
      }
      // Для других ошибок тоже возвращаем null, а не выбрасываем
      console.warn(`Ошибка загрузки изображения ${url}:`, error.message);
      return null;
    }
  }

  // Удалить изображение из кэша
  async remove(url) {
    // Удаляем из памяти
    if (this.memoryCache.has(url)) {
      const objectUrl = this.memoryCache.get(url);
      URL.revokeObjectURL(objectUrl);
      this.memoryCache.delete(url);
    }

    // Удаляем из IndexedDB
    await this.init();
    if (this.db) {
      try {
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        store.delete(url);
      } catch (error) {
        console.warn('Ошибка удаления из IndexedDB:', error);
      }
    }
  }

  // Очистить кэш
  async clear() {
    // Очищаем память
    this.memoryCache.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    this.memoryCache.clear();

    // Очищаем IndexedDB
    await this.init();
    if (this.db) {
      try {
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        store.clear();
      } catch (error) {
        console.warn('Ошибка очистки IndexedDB:', error);
      }
    }
  }

  // Получить размер кэша (приблизительно)
  async getSize() {
    let memorySize = this.memoryCache.size;
    
    await this.init();
    if (!this.db) {
      return { memory: memorySize, indexedDB: 0 };
    }

    try {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.count();
      
      return new Promise((resolve) => {
        request.onsuccess = () => {
          resolve({ memory: memorySize, indexedDB: request.result });
        };
        request.onerror = () => {
          resolve({ memory: memorySize, indexedDB: 0 });
        };
      });
    } catch (error) {
      return { memory: memorySize, indexedDB: 0 };
    }
  }
}

// Создаем единственный экземпляр кэша
const imageCache = new ImageCache();

export default imageCache;

