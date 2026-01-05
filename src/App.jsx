import { useState, useEffect, useRef, useCallback } from 'react';

// Минимальное и максимальное количество тайлов в одном измерении
const MIN_TILES_PER_DIMENSION = 10; // Минимум 20 тайлов по ширине или высоте
const MAX_TILES_PER_DIMENSION = 20; // Максимум 80 тайлов по ширине или высоте
// Порог вариации цвета для дробления области
const VARIANCE_THRESHOLD = 800;
// Максимальный размер канваса для анализа (по большей стороне)
const MAX_CANVAS_SIZE = 512;

// Константы для opacity тайлов
const MIN_OPACITY = 0.25; // Минимальная прозрачность в центре (лицо/центр кадра)
const MAX_OPACITY = 1.0;  // Максимальная прозрачность на краях

// Константа для градиента opacity за пределами маски
// Определяет количество тайлов от границы прозрачной области маски, на котором происходит переход от MIN_OPACITY к MAX_OPACITY
// Значение = количество тайлов (1, 2, 3, ...)
// Больше значение = более плавный/длинный переход (больше тайлов в переходе), меньше = более резкий/короткий переход
const OPACITY_TRANSITION_TILES = 1; // Количество тайлов для перехода от min к max opacity

// Константы для фильтров изображений
const IMAGE_BRIGHTNESS = 0.85; // Яркость тайлов (0.0 - темнее, 1.0 - оригинал, >1.0 - ярче)
const IMAGE_SATURATE = 1.15;   // Насыщенность тайлов (0.0 - ч/б, 1.0 - оригинал, >1.0 - ярче)

// Константа для вариации размера плиток-заполнителей
// Определяет максимальный разброс размера плиток-заполнителей относительно среднего размера
// Значение 5 означает, что размер может варьироваться от 0.2x до 1.0x (разброс в 5 раз)
const BACKGROUND_TILES_SIZE_VARIATION = 5; // Максимальный разброс размера (в разах)

// Константа для увеличения тайла при наведении/клике
const TILE_HOVER_SCALE = 5; // Масштаб увеличения тайла (1.0 = без увеличения, 2.0 = в 2 раза, и т.д.)

// Загрузка маски для фото
// Маска - это PNG файл с альфа-каналом, где прозрачные области = области с min opacity
async function loadMask(maskFilename, canvasWidth, canvasHeight, containerSize) {
  try {
    const maskImg = new Image();
    maskImg.crossOrigin = 'anonymous';
    
    await new Promise((resolve, reject) => {
      maskImg.onload = resolve;
      maskImg.onerror = reject;
      maskImg.src = `/photos/${maskFilename}`;
    });
    
    // Создаём canvas для маски с размером контейнера
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = containerSize.width;
    maskCanvas.height = containerSize.height;
    const maskCtx = maskCanvas.getContext('2d');
    
    // Рисуем маску на canvas контейнера (масштабируем)
    maskCtx.drawImage(maskImg, 0, 0, containerSize.width, containerSize.height);
    
    // Получаем imageData для точной проверки пикселей
    const maskImageData = maskCtx.getImageData(0, 0, containerSize.width, containerSize.height);
    
    return {
      imageData: maskImageData,
      width: containerSize.width,
      height: containerSize.height
    };
  } catch (error) {
    return null;
  }
}

// Проверяет, является ли пиксель прозрачным в маске
function isTransparentInMask(x, y, maskData) {
  if (!maskData || !maskData.imageData) {
    return false;
  }
  
  const imgData = maskData.imageData;
  const px = Math.floor(x);
  const py = Math.floor(y);
  
  if (px < 0 || px >= imgData.width || py < 0 || py >= imgData.height) {
    return false;
  }
  
  const idx = (py * imgData.width + px) * 4;
  const alpha = imgData.data[idx + 3];
  
  // ИНВЕРТИРОВАННАЯ ЛОГИКА: прозрачные области (альфа <= 128) = min opacity
  return alpha <= 128;
}

// Вычисляет расстояние до ближайшей прозрачной точки маски
function distanceToTransparentMask(x, y, maskData, maxSearchDistance = 200) {
  if (!maskData || !maskData.imageData) return Infinity;
  
  // Проверяем саму точку
  if (isTransparentInMask(x, y, maskData)) {
    return 0;
  }
  
  // Ищем ближайшую прозрачную точку в радиусе
  let minDistance = Infinity;
  const imgData = maskData.imageData;
  const searchRadius = Math.min(maxSearchDistance, Math.max(imgData.width, imgData.height) * 0.3);
  
  // Используем более точный поиск с шагом 1 для точного определения границы
  for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
      const checkX = x + dx;
      const checkY = y + dy;
      
      if (isTransparentInMask(checkX, checkY, maskData)) {
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < minDistance) {
          minDistance = distance;
          // Если нашли очень близкую точку, можно прервать поиск для оптимизации
          if (distance < 2) {
            return minDistance;
          }
        }
      }
    }
  }
  
  return minDistance;
}

// Quadtree узел для адаптивного разбиения
class QuadNode {
  constructor(x, y, size, depth = 0) {
    this.x = x;
    this.y = y;
    this.size = size;
    this.depth = depth;
    this.children = null;
    this.avgColor = null;
    this.imageIndex = null;
  }

  subdivide() {
    const halfSize = this.size / 2;
    this.children = [
      new QuadNode(this.x, this.y, halfSize, this.depth + 1),
      new QuadNode(this.x + halfSize, this.y, halfSize, this.depth + 1),
      new QuadNode(this.x, this.y + halfSize, halfSize, this.depth + 1),
      new QuadNode(this.x + halfSize, this.y + halfSize, halfSize, this.depth + 1),
    ];
    return this.children;
  }

  isLeaf() {
    return this.children === null;
  }
}

// Вычисляет вариацию цвета в области (насколько неоднородна область)
function calculateVariance(imageData, x, y, size, canvasWidth) {
  let sumR = 0, sumG = 0, sumB = 0;
  let sumR2 = 0, sumG2 = 0, sumB2 = 0;
  let count = 0;

  const endX = Math.min(x + size, canvasWidth);
  const endY = Math.min(y + size, imageData.height);

  for (let py = y; py < endY; py++) {
    for (let px = x; px < endX; px++) {
      const idx = (py * canvasWidth + px) * 4;
      const r = imageData.data[idx];
      const g = imageData.data[idx + 1];
      const b = imageData.data[idx + 2];

      sumR += r; sumG += g; sumB += b;
      sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
      count++;
    }
  }

  if (count === 0) return 0;

  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;

  const varR = (sumR2 / count) - (meanR * meanR);
  const varG = (sumG2 / count) - (meanG * meanG);
  const varB = (sumB2 / count) - (meanB * meanB);

  return varR + varG + varB;
}

// Вычисляет средний цвет области
function getAreaColor(imageData, x, y, size, canvasWidth) {
  let sumR = 0, sumG = 0, sumB = 0;
  let count = 0;

  const endX = Math.min(Math.floor(x + size), canvasWidth);
  const endY = Math.min(Math.floor(y + size), imageData.height);
  const startX = Math.max(0, Math.floor(x));
  const startY = Math.max(0, Math.floor(y));

  for (let py = startY; py < endY; py++) {
    for (let px = startX; px < endX; px++) {
      if (px >= 0 && px < canvasWidth && py >= 0 && py < imageData.height) {
        const idx = (py * canvasWidth + px) * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        
        // Проверяем на валидность значений
        if (!isNaN(r) && !isNaN(g) && !isNaN(b) && 
            isFinite(r) && isFinite(g) && isFinite(b)) {
          sumR += r;
          sumG += g;
          sumB += b;
          count++;
        }
      }
    }
  }

  if (count === 0) return { r: 128, g: 128, b: 128 };

  const avgR = Math.round(sumR / count);
  const avgG = Math.round(sumG / count);
  const avgB = Math.round(sumB / count);

  // Проверяем результат на валидность
  if (isNaN(avgR) || isNaN(avgG) || isNaN(avgB)) {
    return { r: 128, g: 128, b: 128 };
  }

  return { r: avgR, g: avgG, b: avgB };
}

// Строит Quadtree для изображения
function buildQuadtree(imageData, canvasWidth, canvasHeight) {
  // Вычисляем размер тайла на основе желаемого количества тайлов
  const minTileSize = Math.min(canvasWidth, canvasHeight) / MAX_TILES_PER_DIMENSION;
  const maxTileSize = Math.min(canvasWidth, canvasHeight) / MIN_TILES_PER_DIMENSION;
  
  // Используем квадратный корень для Quadtree (работает с квадратными узлами)
  const rootSize = Math.max(canvasWidth, canvasHeight);
  const root = new QuadNode(0, 0, rootSize);
  const queue = [root];

  while (queue.length > 0) {
    const node = queue.shift();

    // Проверяем выходит ли узел за границы
    if (node.x >= canvasWidth || node.y >= canvasHeight) {
      continue;
    }

    // Ограничиваем размер узла границами изображения
    const actualSize = Math.min(
      node.size,
      canvasWidth - node.x,
      canvasHeight - node.y
    );

    if (actualSize <= 0) continue;

    // Проверяем нужно ли дробить
    if (actualSize > minTileSize) {
      const variance = calculateVariance(imageData, node.x, node.y, actualSize, canvasWidth);
      
      // Дробим если:
      // 1. Высокая вариация и размер больше минимума
      // 2. Размер больше максимума (слишком большой тайл)
      const shouldSplit = 
        (variance > VARIANCE_THRESHOLD && actualSize > minTileSize) ||
        (actualSize > maxTileSize);

      if (shouldSplit) {
        const children = node.subdivide();
        queue.push(...children);
        continue;
      }
    }

    // Это листовой узел - вычисляем средний цвет
    node.avgColor = getAreaColor(imageData, node.x, node.y, actualSize, canvasWidth);
    node.size = actualSize; // Сохраняем реальный размер
  }

  return root;
}

// Собирает все листовые узлы
function collectLeaves(node, leaves = []) {
  if (node.isLeaf()) {
    leaves.push(node);
  } else {
    node.children.forEach(child => collectLeaves(child, leaves));
  }
  return leaves;
}

// Евклидово расстояние между цветами
function colorDistance(c1, c2) {
  // Проверяем на валидность цветов
  if (!c1 || !c2 || 
      isNaN(c1.r) || isNaN(c1.g) || isNaN(c1.b) ||
      isNaN(c2.r) || isNaN(c2.g) || isNaN(c2.b)) {
    return Infinity; // Невалидные цвета - максимальное расстояние
  }
  
  return Math.sqrt(
    Math.pow(c1.r - c2.r, 2) +
    Math.pow(c1.g - c2.g, 2) +
    Math.pow(c1.b - c2.b, 2)
  );
}

// Находит наиболее подходящее фото по цвету с учетом разнообразия
function findBestMatch(targetColor, photoColors, usageCount, excludedIndices = new Set(), diversityBonus = 5000, debugInfo = null) {
  // Сначала находим все кандидаты с их расстояниями
  const candidates = [];
  
  photoColors.forEach((color, index) => {
    // Пропускаем исключенные индексы (например, главное фото)
    if (excludedIndices.has(index)) {
      return;
    }
    
    const originalDistance = colorDistance(targetColor, color);
    const usage = usageCount.get(index) || 0;
    
    // Применяем экспоненциальный штраф за использование
    // Чем больше использований, тем экспоненциально больше штраф
    const penalty = usage > 0 ? diversityBonus * (1 + Math.pow(usage, 1.5)) : 0;
    const distance = originalDistance + penalty;
    
    candidates.push({ index, distance, usage, originalDistance });
  });
  
  // Если нет кандидатов, возвращаем 0 (fallback)
  if (candidates.length === 0) {
    return 0;
  }
  
  // Сортируем по расстоянию (с учетом штрафа)
  candidates.sort((a, b) => a.distance - b.distance);
  
  // Берем топ-20 кандидатов для большего разнообразия
  const topCandidates = candidates.slice(0, Math.min(20, candidates.length));
  
  // Если есть несколько кандидатов с похожим расстоянием, выбираем менее использованный
  if (topCandidates.length > 1) {
    // Находим минимальное расстояние
    const minDistance = topCandidates[0].distance;
    // Берем все кандидаты в пределах 100% от минимума (увеличиваем диапазон для разнообразия)
    const similarCandidates = topCandidates.filter(c => c.distance <= minDistance * 2.0);
    
    // Выбираем наименее использованный среди похожих
    similarCandidates.sort((a, b) => {
      // Сначала по использованию, потом по оригинальному расстоянию
      if (a.usage !== b.usage) {
        return a.usage - b.usage;
      }
      return a.originalDistance - b.originalDistance;
    });
    
    const selected = similarCandidates[0]?.index ?? topCandidates[0].index;
    
    // Отладочная информация
    if (debugInfo && debugInfo.debugMode) {
      if (debugInfo.tileIndex % 100 === 0) { // Логируем каждый 100-й тайл чтобы не засорять консоль
        console.log(`[DEBUG] findBestMatch для тайла ${debugInfo.tileIndex}:`, {
          targetColor,
          selectedIndex: selected,
          selectedUsage: usageCount.get(selected) || 0,
          top3: topCandidates.slice(0, 3).map(c => ({
            index: c.index,
            usage: c.usage,
            originalDistance: Math.round(c.originalDistance),
            distance: Math.round(c.distance),
            penalty: Math.round(c.distance - c.originalDistance)
          })),
          similarCandidatesCount: similarCandidates.length
        });
      }
    }
    
    return selected;
  }
  
  const selected = topCandidates[0]?.index ?? 0;
  
  // Отладочная информация
  if (debugInfo && debugInfo.debugMode) {
    if (debugInfo.tileIndex % 100 === 0) {
      console.log(`[DEBUG] findBestMatch для тайла ${debugInfo.tileIndex}:`, {
        targetColor,
        selectedIndex: selected,
        selectedUsage: usageCount.get(selected) || 0,
        topCandidate: {
          index: topCandidates[0].index,
          usage: topCandidates[0].usage,
          originalDistance: Math.round(topCandidates[0].originalDistance),
          distance: Math.round(topCandidates[0].distance)
        }
      });
    }
  }
  
  return selected;
}

// Вычисляет opacity тайла на основе маски
// ИНВЕРТИРОВАННАЯ ЛОГИКА: прозрачные области маски = min opacity, непрозрачные = max opacity
function calculateTileOpacity(tileCenterX, tileCenterY, containerWidth, containerHeight, maskData = null, averageTileSize = 50) {
  // Если нет маски - все тайлы с максимальной opacity
  if (!maskData || !maskData.imageData) {
    return MAX_OPACITY;
  }
  
  // Проверяем, находится ли центр тайла в прозрачной области маски
  if (isTransparentInMask(tileCenterX, tileCenterY, maskData)) {
    // Внутри прозрачной области маски - всегда MIN_OPACITY
    return MIN_OPACITY;
  }
  
  // Тайл находится вне прозрачной области маски
  // Вычисляем расстояние до ближайшей прозрачной точки маски
  // Используем средний размер тайла для ограничения радиуса поиска
  const maxSearchDistance = averageTileSize * OPACITY_TRANSITION_TILES * 3; // Увеличиваем радиус поиска
  const minDistanceToMask = distanceToTransparentMask(tileCenterX, tileCenterY, maskData, maxSearchDistance);
  
  // Если не нашли прозрачную область в радиусе поиска - максимальная opacity
  if (minDistanceToMask === Infinity) {
    return MAX_OPACITY;
  }
  
  // Применяем градиент: чем дальше от маски, тем больше opacity
  // Используем средний размер тайла для вычисления расстояния перехода
  // OPACITY_TRANSITION_TILES определяет количество тайлов для перехода
  const transitionDistance = averageTileSize * OPACITY_TRANSITION_TILES;
  
  // Нормализуем расстояние (0 = на границе маски, 1 = далеко от маски)
  const normalizedDistance = Math.min(minDistanceToMask / transitionDistance, 1);
  
  // Градиент от MIN_OPACITY (близко к маске) к MAX_OPACITY (далеко от маски)
  const opacity = MIN_OPACITY + (MAX_OPACITY - MIN_OPACITY) * normalizedDistance;
  
  return Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, opacity));
}

function App() {
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [photoIndex, setPhotoIndex] = useState(null);
  const [images, setImages] = useState([]);
  const [photoColors, setPhotoColors] = useState([]);
  const [photoAspects, setPhotoAspects] = useState([]);
  const [slideshowPhotos, setSlideshowPhotos] = useState([]);
  const [currentMainIndex, setCurrentMainIndex] = useState(0);
  const [tiles, setTiles] = useState([]);
  const [transitioning, setTransitioning] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [mainImageSize, setMainImageSize] = useState({ width: 0, height: 0, x: 0, y: 0 });
  const [imageAspectRatio, setImageAspectRatio] = useState(1);
  const [mainImageUrl, setMainImageUrl] = useState(null);
  const [edgeColors, setEdgeColors] = useState([]);
  const [autoPlay, setAutoPlay] = useState(false);
  const [maskData, setMaskData] = useState(null);
  const [debugMode, setDebugMode] = useState(false);
  const [isGeneratingHighRes, setIsGeneratingHighRes] = useState(false);
  const [hoveredTileIndex, setHoveredTileIndex] = useState(null);

  const canvasRef = useRef(null);
  const ctxRef = useRef(null);

  // Читаем параметры из query string
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const playParam = params.get('play');
    // Автопроигрывание включается только при play=1
    setAutoPlay(playParam === '1');
    const debugParam = params.get('debug');
    setDebugMode(debugParam === '1');
  }, []);

  // Устанавливаем начальный индекс фото из query string
  useEffect(() => {
    if (slideshowPhotos.length > 0) {
      const params = new URLSearchParams(window.location.search);
      const photoParam = params.get('photo');
      if (photoParam !== null) {
        const photoIndex = parseInt(photoParam, 10);
        if (!isNaN(photoIndex) && photoIndex >= 0 && photoIndex < slideshowPhotos.length) {
          setCurrentMainIndex(photoIndex);
        }
      } else {
        // Если параметра нет, устанавливаем его в URL
        const params = new URLSearchParams(window.location.search);
        params.set('photo', '0');
        window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
      }
    }
  }, [slideshowPhotos]);

  // Инициализируем canvas
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvasRef.current = canvas;
    ctxRef.current = canvas.getContext('2d', { willReadFrequently: true });
  }, []);

  // Загружаем индекс фотографий и проверяем наличие масок
  useEffect(() => {
    fetch('/photos/index.json')
      .then(res => res.json())
      .then(async (data) => {
        setPhotoIndex(data);
        
        // Проверяем наличие масок для ВСЕХ фото
        // Фото считается главным только если у него есть PNG маска
        const slideshowList = [];
        
        if (debugMode) {
          console.log('[DEBUG] Проверка масок для всех фото...', {
            totalPhotos: data.photos.length
          });
        }
        
        // Проверяем наличие масок параллельно для всех фото
        const checkPromises = data.photos.map(async (photo) => {
          // Проверяем только JPG/JPEG файлы (не PNG)
          const ext = photo.filename.toLowerCase();
          if (!ext.endsWith('.jpg') && !ext.endsWith('.jpeg')) {
            return { photo, hasMask: false, reason: 'not_jpg' };
          }
          
          const baseName = photo.filename.replace(/\.(jpg|jpeg)$/i, '');
          const maskFilename = `${baseName}.png`;
          const maskUrl = `/photos/${maskFilename}`;
          
          // Проверяем наличие маски через GET запрос (более надежно, чем HEAD)
          // Используем небольшой range запрос чтобы не загружать весь файл
          try {
            const response = await fetch(maskUrl, { 
              method: 'GET',
              headers: {
                'Range': 'bytes=0-0' // Запрашиваем только первый байт
              },
              cache: 'no-cache' // Отключаем кэш для точной проверки
            });
            
            // Проверяем статус и content-type
            const contentType = response.headers.get('content-type');
            const isImage = contentType && (contentType.startsWith('image/') || contentType.includes('png'));
            
            // 206 = Partial Content (файл существует), 200 = OK (файл существует)
            const fileExists = response.status === 200 || response.status === 206;
            
            if (fileExists && isImage) {
              if (debugMode) {
                console.log('[DEBUG] Маска найдена:', maskFilename, {
                  status: response.status,
                  contentType,
                  filename: photo.filename
                });
              }
              return { photo, hasMask: true };
            } else {
              if (debugMode) {
                console.log('[DEBUG] Маска не найдена:', maskFilename, {
                  status: response.status,
                  contentType,
                  fileExists,
                  isImage,
                  filename: photo.filename
                });
              }
              return { photo, hasMask: false, reason: 'not_found' };
            }
          } catch (e) {
            // Маска не найдена (404 или другая ошибка)
            if (debugMode) {
              console.log('[DEBUG] Ошибка проверки маски:', maskFilename, {
                error: e.message,
                filename: photo.filename
              });
            }
            return { photo, hasMask: false, reason: 'error', error: e.message };
          }
        });
        
        const results = await Promise.all(checkPromises);
        
        // Добавляем в слайд-шоу только фото с масками
        results.forEach(({ photo, hasMask, reason }) => {
          if (hasMask) {
            slideshowList.push(photo);
          }
        });
        
        if (debugMode) {
          console.log('[DEBUG] Фото в слайд-шоу (с масками):', {
            totalPhotos: data.photos.length,
            withMasks: slideshowList.length,
            photos: slideshowList.map(p => p.filename)
          });
          
          // Показываем статистику по причинам исключения
          const stats = {};
          results.forEach(({ reason }) => {
            if (reason) {
              stats[reason] = (stats[reason] || 0) + 1;
            }
          });
          console.log('[DEBUG] Статистика исключений:', stats);
        }
        
        setSlideshowPhotos(slideshowList);
      })
      .catch(err => {
        console.error('Ошибка загрузки index.json:', err);
      });
  }, [debugMode]);

  // Загружаем изображения после получения индекса
  useEffect(() => {
    if (!photoIndex) return;

    const loadImages = async () => {
      setLoadingProgress('Загрузка изображений...');

      const loadedImages = [];
      const colors = [];
      const photoAspects = [];
      const photos = photoIndex.photos;

      // Используем пропорции из index.json (быстрее, чем загружать все изображения)
      photos.forEach(photo => {
        const aspect = photo.width / photo.height;
        photoAspects.push(aspect);
        colors.push(photo.avgColor);
        loadedImages.push({ filename: photo.filename });
      });

      setLoadingProgress('Готово!');

      setImages(loadedImages);
      setPhotoColors(colors);
      setPhotoAspects(photoAspects);
      setLoadingProgress('Готово!');
      setLoading(false);
    };

    // Ждём инициализации canvas
    const checkCanvas = setInterval(() => {
      if (canvasRef.current && ctxRef.current) {
        clearInterval(checkCanvas);
        loadImages();
      }
    }, 100);

    return () => clearInterval(checkCanvas);
  }, [photoIndex]);

  // Вычисляем размер контейнера на основе доступного пространства
  useEffect(() => {
    const updateSize = () => {
      if (debugMode) {
        console.log('[DEBUG] updateSize вызван');
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Оставляем место для заголовка и индикаторов
      const headerHeight = 80;
      const indicatorHeight = 40;
      const availableHeight = vh - headerHeight - indicatorHeight;
      
      // Оставляем место для стрелок навигации (ширина стрелки + gap с обеих сторон)
      // На мобильных устройствах кнопки меньше (40px) и gap меньше (8px)
      const isMobile = vw <= 768;
      const navButtonWidth = isMobile ? 40 : 50; // Ширина кнопки навигации
      const navGap = isMobile ? 8 : 16; // gap между стрелками и контейнером (0.5rem на мобильных, 1rem на десктопе)
      const navButtonsSpace = (navButtonWidth + navGap) * 2; // Место для обеих стрелок и gap
      const availableWidth = vw - navButtonsSpace;

      // Контейнер занимает доступное пространство с учетом стрелок
      const containerWidth = availableWidth;
      const containerHeight = availableHeight;

      if (debugMode) {
        console.log('[DEBUG] containerSize обновлен:', { width: containerWidth, height: containerHeight });
      }
      setContainerSize({ width: containerWidth, height: containerHeight });
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [debugMode]);

  // Генерируем мозаику
  const generateMosaic = useCallback(async () => {
    if (images.length === 0 || slideshowPhotos.length === 0 || !containerSize.width) return;
    
    if (debugMode) {
      console.log('[DEBUG] generateMosaic вызван', {
        imagesCount: images.length,
        slideshowPhotosCount: slideshowPhotos.length,
        containerSize,
        currentMainIndex
      });
    }

    const currentPhoto = slideshowPhotos[currentMainIndex];
    
    // Загружаем основное фото (оригинальное, не сжатое)
    const mainImage = new Image();
    mainImage.crossOrigin = 'anonymous';
    
    try {
      await new Promise((resolve, reject) => {
        mainImage.onload = resolve;
        mainImage.onerror = reject;
        mainImage.src = `/photos/${currentPhoto.filename}`;
      });
    } catch (e) {
      console.error('Ошибка загрузки основного фото:', currentPhoto.filename);
      return;
    }
    
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;

    // Вычисляем пропорции изображения
    const imgAspect = mainImage.naturalWidth / mainImage.naturalHeight;
    setImageAspectRatio(imgAspect);
    
    // Устанавливаем URL основного фото для фона
    setMainImageUrl(`/photos/${currentPhoto.filename}`);

    // Вычисляем размер главного фото, вписанного в контейнер (contain)
    const containerAspect = containerSize.width / containerSize.height;
    let mainImgWidth, mainImgHeight, mainImgX, mainImgY;
    
    if (imgAspect > containerAspect) {
      // Изображение шире - подгоняем по ширине контейнера
      mainImgWidth = containerSize.width;
      mainImgHeight = mainImgWidth / imgAspect;
      mainImgX = 0;
      mainImgY = (containerSize.height - mainImgHeight) / 2;
    } else {
      // Изображение выше - подгоняем по высоте контейнера
      mainImgHeight = containerSize.height;
      mainImgWidth = mainImgHeight * imgAspect;
      mainImgX = (containerSize.width - mainImgWidth) / 2;
      mainImgY = 0;
    }
    
    setMainImageSize({ width: mainImgWidth, height: mainImgHeight, x: mainImgX, y: mainImgY });

    // Вычисляем размер canvas для анализа главного фото
    let canvasWidth, canvasHeight;
    if (imgAspect > 1) {
      canvasWidth = MAX_CANVAS_SIZE;
      canvasHeight = MAX_CANVAS_SIZE / imgAspect;
    } else {
      canvasHeight = MAX_CANVAS_SIZE;
      canvasWidth = MAX_CANVAS_SIZE * imgAspect;
    }

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Очищаем canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Рисуем основное изображение на canvas с сохранением пропорций (cover для анализа)
    let drawWidth = canvasWidth;
    let drawHeight = canvasHeight;
    let drawX = 0;
    let drawY = 0;

    const imgAspectCanvas = canvasWidth / canvasHeight;
    
    if (imgAspect > imgAspectCanvas) {
      // Изображение шире - подгоняем по высоте
      drawHeight = canvasHeight;
      drawWidth = drawHeight * imgAspect;
      drawX = (canvasWidth - drawWidth) / 2;
    } else {
      // Изображение выше - подгоняем по ширине
      drawWidth = canvasWidth;
      drawHeight = drawWidth / imgAspect;
      drawY = (canvasHeight - drawHeight) / 2;
    }

    ctx.drawImage(mainImage, drawX, drawY, drawWidth, drawHeight);
    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    
    // Получаем цвета краев главного фото для заполнения оставшегося пространства
    const edgeColorSamples = [];
    const sampleSize = 20; // Размер области для выборки
    const samplePositions = [
      // Верхний край
      { x: drawX + drawWidth * 0.1, y: drawY, size: drawWidth * 0.8 },
      { x: drawX + drawWidth * 0.3, y: drawY, size: drawWidth * 0.4 },
      { x: drawX + drawWidth * 0.5, y: drawY, size: drawWidth * 0.2 },
      // Нижний край
      { x: drawX + drawWidth * 0.1, y: drawY + drawHeight, size: drawWidth * 0.8 },
      { x: drawX + drawWidth * 0.3, y: drawY + drawHeight, size: drawWidth * 0.4 },
      { x: drawX + drawWidth * 0.5, y: drawY + drawHeight, size: drawWidth * 0.2 },
      // Левый край
      { x: drawX, y: drawY + drawHeight * 0.1, size: drawHeight * 0.8 },
      { x: drawX, y: drawY + drawHeight * 0.3, size: drawHeight * 0.4 },
      { x: drawX, y: drawY + drawHeight * 0.5, size: drawHeight * 0.2 },
      // Правый край
      { x: drawX + drawWidth, y: drawY + drawHeight * 0.1, size: drawHeight * 0.8 },
      { x: drawX + drawWidth, y: drawY + drawHeight * 0.3, size: drawHeight * 0.4 },
      { x: drawX + drawWidth, y: drawY + drawHeight * 0.5, size: drawHeight * 0.2 },
    ];
    
    samplePositions.forEach(pos => {
      const color = getAreaColor(imageData, pos.x, pos.y, pos.size, canvasWidth);
      edgeColorSamples.push(color);
    });
    
    setEdgeColors(edgeColorSamples);

    // Загружаем маску синхронно (если есть)
    // Маска имеет то же имя что и фото, но с расширением PNG
    // Масштабируем маску до размера главного фото в контейнере
    const baseName = currentPhoto.filename.replace(/\.(jpg|jpeg)$/i, '');
    const maskFilename = `${baseName}.png`;
    let currentMaskData = null;
    try {
      const maskSize = { width: mainImgWidth, height: mainImgHeight };
      const mask = await loadMask(maskFilename, canvasWidth, canvasHeight, maskSize);
      if (mask && mask.imageData) {
        currentMaskData = mask;
        if (debugMode) {
          console.log('[DEBUG] Маска загружена:', {
            filename: maskFilename,
            width: mask.width,
            height: mask.height
          });
        }
      } else {
        // Маска не найдена - это нормально, но не должно быть в слайд-шоу
        if (debugMode) {
          console.log('[DEBUG] Маска не найдена при генерации мозаики:', maskFilename);
        }
      }
    } catch (e) {
      // Маска не найдена - это нормально (не главное фото)
      if (debugMode) {
        console.log('[DEBUG] Ошибка загрузки маски для:', maskFilename);
      }
    }

    // Строим Quadtree
    const root = buildQuadtree(imageData, canvasWidth, canvasHeight);
    const leaves = collectLeaves(root).filter(node => {
      // Фильтруем узлы с валидным цветом
      if (!node.avgColor) return false;
      const c = node.avgColor;
      return !isNaN(c.r) && !isNaN(c.g) && !isNaN(c.b) &&
             isFinite(c.r) && isFinite(c.g) && isFinite(c.b);
    });

    // Масштаб от canvas к размеру главного фото в контейнере
    const scaleX = mainImgWidth / canvasWidth;
    const scaleY = mainImgHeight / canvasHeight;

    // Исключаем текущее главное фото из списка доступных для тайлов
    const currentMainPhotoIndex = images.findIndex(img => img.filename === currentPhoto.filename);
    const excludedIndices = new Set();
    if (currentMainPhotoIndex !== -1) {
      excludedIndices.add(currentMainPhotoIndex);
    }

    // Создаём плитки с сохранением пропорций исходных фото
    // Используем Map для подсчета использований каждого фото
    const usageCount = new Map();
    
    // Вычисляем средний размер тайла для градиента opacity
    // Используем средний размер узлов quadtree, масштабированный до размера главного фото
    const avgNodeSize = leaves.reduce((sum, node) => sum + node.size, 0) / leaves.length;
    const averageTileSize = avgNodeSize * Math.max(scaleX, scaleY);
    
    // Генерируем плитки для главного фото
    const mainImageTiles = leaves.map((node, tileIndex) => {
      // Пропускаем невалидные узлы
      if (!node.avgColor || 
          isNaN(node.avgColor.r) || isNaN(node.avgColor.g) || isNaN(node.avgColor.b)) {
        return null;
      }
      // Определяем, находится ли тайл на краю изображения
      // Для краевых тайлов снижаем важность точного совпадения цвета
      const isEdgeTile = node.x < canvasWidth * 0.1 || 
                         node.x + node.size > canvasWidth * 0.9 ||
                         node.y < canvasHeight * 0.1 || 
                         node.y + node.size > canvasHeight * 0.9;
      
      // Для краевых тайлов увеличиваем разнообразие (снижаем важность цвета)
      const edgeDiversityBonus = isEdgeTile ? 10000 : 5000;
      
      const bestIndex = findBestMatch(
        node.avgColor, 
        photoColors, 
        usageCount, 
        excludedIndices, 
        edgeDiversityBonus,
        { debugMode, tileIndex }
      );
      
      // Увеличиваем счетчик использования
      usageCount.set(bestIndex, (usageCount.get(bestIndex) || 0) + 1);

      // Получаем пропорции фото для этой плитки
      const photoAspect = photoAspects[bestIndex] || 1;
      
      // Базовый размер плитки (квадрат в canvas)
      const baseSize = node.size;
      
      // Вычисляем размеры плитки с возможностью обрезки до 20% для минимизации пустот
      let tileWidth, tileHeight;
      
      // Вычисляем размеры с точными пропорциями фото
      let naturalWidth = baseSize;
      let naturalHeight = baseSize / photoAspect;
      
      if (naturalHeight > baseSize) {
        // Если высота превышает доступное пространство, пересчитываем
        naturalHeight = baseSize;
        naturalWidth = baseSize * photoAspect;
      }
      
      // Проверяем, можем ли мы обрезать до 20% для лучшего заполнения
      const minSize = baseSize * 0.2; // Минимальный размер после обрезки
      
      if (photoAspect > 1) {
        // Горизонтальное фото
        // Вариант 1: Точные пропорции
        const emptySpace1 = baseSize - naturalHeight;
        
        // Вариант 2: Заполняем по высоте, обрезаем по ширине (если обрезка >= 20%)
        const w2 = baseSize;
        const h2 = baseSize;
        const cropRatio = naturalWidth / w2;
        const emptySpace2 = 0;
        
        // Выбираем вариант с меньшими пустотами, но с ограничением обрезки >= 20%
        if (emptySpace2 < emptySpace1 && cropRatio >= 0.2) {
          tileWidth = w2;
          tileHeight = h2;
        } else {
          tileWidth = naturalWidth;
          tileHeight = naturalHeight;
        }
      } else {
        // Вертикальное фото
        // Вариант 1: Точные пропорции
        const emptySpace1 = baseSize - naturalWidth;
        
        // Вариант 2: Заполняем по ширине, обрезаем по высоте (если обрезка >= 20%)
        const w2 = baseSize;
        const h2 = baseSize;
        const cropRatio = naturalHeight / h2;
        const emptySpace2 = 0;
        
        // Выбираем вариант с меньшими пустотами, но с ограничением обрезки >= 20%
        if (emptySpace2 < emptySpace1 && cropRatio >= 0.2) {
          tileWidth = w2;
          tileHeight = h2;
        } else {
          tileWidth = naturalWidth;
          tileHeight = naturalHeight;
        }
      }

      // Вычисляем центр тайла для определения opacity (относительно главного фото)
      const tileCenterX = mainImgX + (node.x + tileWidth / 2) * scaleX;
      const tileCenterY = mainImgY + (node.y + tileHeight / 2) * scaleY;
      
      // Вычисляем opacity на основе маски
      // Координаты относительно главного фото для маски
      const maskX = tileCenterX - mainImgX;
      const maskY = tileCenterY - mainImgY;
      const opacity = calculateTileOpacity(
        maskX,
        maskY,
        mainImgWidth,
        mainImgHeight,
        currentMaskData,
        averageTileSize
      );
      
      return {
        x: mainImgX + node.x * scaleX,
        y: mainImgY + node.y * scaleY,
        width: tileWidth * scaleX,
        height: tileHeight * scaleY,
        imageIndex: bestIndex,
        avgColor: node.avgColor,
        centerX: tileCenterX,
        centerY: tileCenterY,
        opacity,
      };
    }).filter(tile => tile !== null); // Фильтруем null тайлы
    
    // Вычисляем средний размер плиток на главном фото
    const mainTilesAvgSize = mainImageTiles.length > 0
      ? mainImageTiles.reduce((sum, tile) => sum + Math.sqrt(tile.width * tile.height), 0) / mainImageTiles.length
      : averageTileSize;
    
    // Генерируем плитки для оставшегося пространства контейнера
    // Используем цвета краев главного фото
    const backgroundTiles = [];
    // Базовый размер плитки равен среднему размеру плиток на главном фото
    const baseTileSize = mainTilesAvgSize;
    
    // Определяем области, которые нужно заполнить
    const emptyAreas = [];
    
    // Верхняя область
    if (mainImgY > 0) {
      emptyAreas.push({
        x: 0,
        y: 0,
        width: containerSize.width,
        height: mainImgY
      });
    }
    
    // Нижняя область
    if (mainImgY + mainImgHeight < containerSize.height) {
      emptyAreas.push({
        x: 0,
        y: mainImgY + mainImgHeight,
        width: containerSize.width,
        height: containerSize.height - (mainImgY + mainImgHeight)
      });
    }
    
    // Левая область
    if (mainImgX > 0) {
      emptyAreas.push({
        x: 0,
        y: mainImgY,
        width: mainImgX,
        height: mainImgHeight
      });
    }
    
    // Правая область
    if (mainImgX + mainImgWidth < containerSize.width) {
      emptyAreas.push({
        x: mainImgX + mainImgWidth,
        y: mainImgY,
        width: containerSize.width - (mainImgX + mainImgWidth),
        height: mainImgHeight
      });
    }
    
    // Заполняем пустые области плитками без зазоров
    emptyAreas.forEach(area => {
      // Вычисляем количество плиток на основе базового размера
      const tilesX = Math.ceil(area.width / baseTileSize);
      const tilesY = Math.ceil(area.height / baseTileSize);
      
      // Вычисляем реальный размер плитки, чтобы заполнить всю область без зазоров
      const actualTileWidth = area.width / tilesX;
      const actualTileHeight = area.height / tilesY;
      
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          const x = area.x + tx * actualTileWidth;
          const y = area.y + ty * actualTileHeight;
          
          // Размер плитки точно равен вычисленному размеру
          let width = actualTileWidth;
          let height = actualTileHeight;
          
          // Для последних плиток в ряду/колонке убеждаемся, что они доходят до края
          if (tx === tilesX - 1) {
            width = area.x + area.width - x;
          }
          if (ty === tilesY - 1) {
            height = area.y + area.height - y;
          }
          
          // Пропускаем слишком маленькие плитки
          if (width < baseTileSize * 0.2 || height < baseTileSize * 0.2) {
            continue;
          }
          
          // Выбираем случайный цвет из краев главного фото
          const edgeColor = edgeColorSamples[Math.floor(Math.random() * edgeColorSamples.length)];
          
          // Находим лучшее совпадение для этого цвета
          const bestIndex = findBestMatch(
            edgeColor,
            photoColors,
            usageCount,
            excludedIndices,
            5000,
            { debugMode, tileIndex: mainImageTiles.length + backgroundTiles.length }
          );
          
          usageCount.set(bestIndex, (usageCount.get(bestIndex) || 0) + 1);
          
          // Для фоновых плиток всегда используем полный размер без зазоров
          // Фото будет обрезано через object-fit: cover в CSS
          backgroundTiles.push({
            x,
            y,
            width: width,  // Всегда используем полную ширину без зазоров
            height: height, // Всегда используем полную высоту без зазоров
            imageIndex: bestIndex,
            avgColor: edgeColor,
            centerX: x + width / 2,
            centerY: y + height / 2,
            opacity: MAX_OPACITY, // Фоновые плитки всегда с максимальной opacity
          });
        }
      }
    });
    
    const newTiles = [...mainImageTiles, ...backgroundTiles];

    if (debugMode) {
      console.log('[DEBUG] Мозаика сгенерирована:', {
        tilesCount: newTiles.length,
        opacityRange: {
          min: Math.min(...newTiles.map(t => t.opacity)),
          max: Math.max(...newTiles.map(t => t.opacity))
        }
      });
    }
    
    // Обновляем маску в состоянии только один раз после генерации
    setMaskData(currentMaskData);
    
    setTiles(newTiles);
  }, [images, photoColors, photoAspects, slideshowPhotos, currentMainIndex, containerSize, debugMode]);

  // Регенерируем мозаику при смене параметров
  useEffect(() => {
    if (debugMode) {
      console.log('[DEBUG] useEffect для generateMosaic:', {
        loading,
        containerSize,
        currentMainIndex
      });
    }
    if (!loading && containerSize.width > 0) {
      generateMosaic();
      // Сбрасываем активный тайл при смене слайда
      setHoveredTileIndex(null);
    }
  }, [loading, currentMainIndex, generateMosaic, containerSize, debugMode]);

  // Автоматическая смена основного фото каждые 5 секунд (только если autoPlay = true)
  useEffect(() => {
    if (loading || slideshowPhotos.length === 0 || !autoPlay) return;
    if (debugMode) {
      console.log('[DEBUG] Автопереключение слайда');
    }

    const interval = setInterval(() => {
      setTransitioning(true);

      setTimeout(() => {
        setCurrentMainIndex(prev => (prev + 1) % slideshowPhotos.length);
        setTimeout(() => {
          setTransitioning(false);
        }, 100);
      }, 500);
    }, 5000);

    return () => clearInterval(interval);
  }, [loading, slideshowPhotos.length, autoPlay]);

  // Функция для переключения слайда
  const changeSlide = useCallback((direction) => {
    if (slideshowPhotos.length === 0) return;
    
    setTransitioning(true);
    setTimeout(() => {
      let newIndex;
      if (direction === 'next') {
        newIndex = (currentMainIndex + 1) % slideshowPhotos.length;
      } else {
        newIndex = (currentMainIndex - 1 + slideshowPhotos.length) % slideshowPhotos.length;
      }
      
      setCurrentMainIndex(newIndex);
      
      // Обновляем URL с параметром photo
      const params = new URLSearchParams(window.location.search);
      params.set('photo', newIndex.toString());
      window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
      
      setTimeout(() => {
        setTransitioning(false);
      }, 100);
    }, 500);
  }, [slideshowPhotos.length, currentMainIndex]);

  // Генерация мозаики в высоком разрешении для печати
  const downloadHighRes = useCallback(async () => {
    if (tiles.length === 0 || !mainImageUrl || isGeneratingHighRes) return;
    
    setIsGeneratingHighRes(true);
    
    try {
      // Коэффициент масштабирования для высокого разрешения (300 DPI для печати)
      // Для плаката A2 (16.5x23.4 дюйма) при 300 DPI = 4950x7020 пикселей
      // Используем коэффициент 4x от текущего размера для баланса качества и размера файла
      const scaleFactor = 4;
      
      // Загружаем основное фото в высоком разрешении
      const mainImg = new Image();
      mainImg.crossOrigin = 'anonymous';
      
      await new Promise((resolve, reject) => {
        mainImg.onload = resolve;
        mainImg.onerror = reject;
        mainImg.src = mainImageUrl;
      });
      
      // Вычисляем пропорции основного изображения
      const imgAspect = mainImg.naturalWidth / mainImg.naturalHeight;
      
      // Используем размер основного изображения в контейнере (mainImageSize) для правильного масштабирования
      // Масштабируем mainImageSize с сохранением пропорций
      const mainImgWidth = mainImageSize.width * scaleFactor;
      const mainImgHeight = mainImageSize.height * scaleFactor;
      const mainImgX = mainImageSize.x * scaleFactor;
      const mainImgY = mainImageSize.y * scaleFactor;
      
      // Размер canvas равен размеру контейнера, масштабированному
      const canvasWidth = Math.round(containerSize.width * scaleFactor);
      const canvasHeight = Math.round(containerSize.height * scaleFactor);
      
      // Создаем canvas для высокого разрешения
      const highResCanvas = document.createElement('canvas');
      highResCanvas.width = canvasWidth;
      highResCanvas.height = canvasHeight;
      const highResCtx = highResCanvas.getContext('2d');
      
      // Рисуем фон (основное фото) с сохранением пропорций в том же месте, где оно находится в контейнере
      highResCtx.drawImage(mainImg, mainImgX, mainImgY, mainImgWidth, mainImgHeight);
      
      // Загружаем и рисуем все тайлы
      const tilePromises = tiles.map(async (tile, index) => {
        const tileImg = new Image();
        tileImg.crossOrigin = 'anonymous';
        
        return new Promise((resolve) => {
          tileImg.onload = () => {
            // Масштабируем координаты и размеры тайла
            // Используем scaleFactor для масштабирования относительно контейнера
            const x = tile.x * scaleFactor;
            const y = tile.y * scaleFactor;
            const width = tile.width * scaleFactor;
            const height = tile.height * scaleFactor;
            
            // Сохраняем состояние контекста
            highResCtx.save();
            
            // Применяем opacity
            highResCtx.globalAlpha = tile.opacity || MIN_OPACITY;
            
            // Применяем фильтры (brightness и saturate через canvas не поддерживаются напрямую,
            // но можно использовать composite operations или нарисовать через фильтрованный canvas)
            const filterCanvas = document.createElement('canvas');
            filterCanvas.width = tileImg.width;
            filterCanvas.height = tileImg.height;
            const filterCtx = filterCanvas.getContext('2d');
            
            // Применяем brightness и saturate через фильтры (если не в debug режиме)
            if (!debugMode) {
              filterCtx.filter = `brightness(${IMAGE_BRIGHTNESS}) saturate(${IMAGE_SATURATE})`;
            }
            filterCtx.drawImage(tileImg, 0, 0);
            
            // Рисуем отфильтрованное изображение на основном canvas
            highResCtx.drawImage(filterCanvas, x, y, width, height);
            
            // Восстанавливаем состояние
            highResCtx.restore();
            
            resolve();
          };
          tileImg.onerror = () => resolve(); // Пропускаем ошибки загрузки
          tileImg.src = `/tiles/${images[tile.imageIndex]?.filename}`;
        });
      });
      
      // Ждем загрузки всех тайлов
      await Promise.all(tilePromises);
      
      // Вспомогательная функция для скачивания blob
      const downloadBlob = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.position = 'fixed';
        a.style.top = '-9999px';
        a.style.left = '-9999px';
        document.body.appendChild(a);
        
        // Используем requestAnimationFrame для надежности
        requestAnimationFrame(() => {
          a.click();
          // Удаляем ссылку после небольшой задержки
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 100);
        });
      };
      
      // Конвертируем canvas в blob и скачиваем
      highResCanvas.toBlob((blob) => {
        if (blob) {
          const currentPhoto = slideshowPhotos[currentMainIndex];
          const filename = currentPhoto 
            ? `mosaic-${currentPhoto.filename.replace(/\.(jpg|jpeg)$/i, '')}-${canvasWidth}x${canvasHeight}.png`
            : `mosaic-${canvasWidth}x${canvasHeight}.png`;
          
          // Проверяем, является ли это мобильным устройством
          const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
          
          if (isMobile) {
            // Для мобильных устройств используем более надежный метод
            // Пробуем использовать File System Access API или fallback на стандартный метод
            if ('showSaveFilePicker' in window) {
              // Используем File System Access API (поддерживается в современных браузерах)
              window.showSaveFilePicker({
                suggestedName: filename,
                types: [{
                  description: 'PNG Image',
                  accept: { 'image/png': ['.png'] }
                }]
              }).then(async (fileHandle) => {
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                setIsGeneratingHighRes(false);
              }).catch((err) => {
                console.error('Ошибка сохранения файла:', err);
                // Fallback на стандартный метод
                downloadBlob(blob, filename);
                setIsGeneratingHighRes(false);
              });
            } else {
              // Fallback: используем стандартный метод с улучшениями для мобильных
              downloadBlob(blob, filename);
              setIsGeneratingHighRes(false);
            }
          } else {
            // Для десктопа используем стандартный метод
            downloadBlob(blob, filename);
            setIsGeneratingHighRes(false);
          }
        } else {
          setIsGeneratingHighRes(false);
        }
      }, 'image/png', 1.0); // Максимальное качество PNG
      
    } catch (error) {
      console.error('Ошибка генерации высокого разрешения:', error);
      setIsGeneratingHighRes(false);
    }
  }, [tiles, mainImageUrl, containerSize, images, slideshowPhotos, currentMainIndex, debugMode, isGeneratingHighRes, MIN_OPACITY, IMAGE_BRIGHTNESS, IMAGE_SATURATE]);

  // Ручной выбор основного фото
  const handleIndicatorClick = (index) => {
    if (index === currentMainIndex) return;

    setTransitioning(true);
    setTimeout(() => {
      setCurrentMainIndex(index);
      
      // Обновляем URL с параметром photo
      const params = new URLSearchParams(window.location.search);
      params.set('photo', index.toString());
      window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
      
      setTimeout(() => {
        setTransitioning(false);
      }, 100);
    }, 500);
  };

  // Обработка клавиатуры (стрелки влево/вправо)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        changeSlide('prev');
      } else if (e.key === 'ArrowRight') {
        changeSlide('next');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [changeSlide]);

  if (loading) {
    return (
      <div className="app">
        <div className="loading">
          <div className="loading-spinner" />
          <div>Создание мозаики...</div>
          <div className="progress-info">{loadingProgress}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', maxWidth: '100vw', padding: '10px 20px 0 20px', position: 'relative' }}>
        <h1 className="title" style={{ margin: 0, textAlign: 'center', width: '100%' }}>С днем рождения, мамочка!</h1>
      </div>

      <div className="mosaic-wrapper">
        <button
          className="nav-button nav-button-left"
          onClick={() => changeSlide('prev')}
          aria-label="Предыдущее фото"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>

        <div
          className="mosaic-container"
          style={{ 
            width: containerSize.width,
            height: containerSize.height,
            backgroundColor: '#0a0a0a',
            position: 'relative'
          }}
        >
        {mainImageUrl && mainImageSize.width > 0 && (
          <img
            src={mainImageUrl}
            alt="Main photo"
            className="main-photo"
            style={{
              position: 'absolute',
              left: mainImageSize.x,
              top: mainImageSize.y,
              width: mainImageSize.width,
              height: mainImageSize.height,
              objectFit: 'contain',
              zIndex: 1
            }}
          />
        )}
        <div 
          className="mosaic-tiles"
          style={{
            '--tile-hover-scale': TILE_HOVER_SCALE,
            width: containerSize.width,
            height: containerSize.height,
            overflow: hoveredTileIndex !== null ? 'visible' : 'hidden',
          }}
          onClick={(e) => {
            // Сбрасываем активный тайл при клике вне тайла (только для мобильных)
            if (e.target === e.currentTarget && hoveredTileIndex !== null) {
              setHoveredTileIndex(null);
            }
          }}
        >
          {tiles.map((tile, index) => {
            const isActive = hoveredTileIndex === index;
            const tileKey = `${currentMainIndex}-${index}`;
            return (
              <div
                key={tileKey}
                className={`mosaic-tile ${isActive ? 'active' : ''}`}
                style={{
                  left: tile.x,
                  top: tile.y,
                  width: tile.width,
                  height: tile.height,
                }}
                onMouseEnter={() => setHoveredTileIndex(index)}
                onMouseLeave={() => setHoveredTileIndex(null)}
                onClick={(e) => {
                  e.stopPropagation(); // Предотвращаем всплытие события
                  // Для мобильных устройств переключаем состояние по клику
                  if (hoveredTileIndex === index) {
                    setHoveredTileIndex(null);
                  } else {
                    setHoveredTileIndex(index);
                  }
                }}
              >
                <img
                  src={`/tiles/${images[tile.imageIndex]?.filename}`}
                  alt=""
                  loading="lazy"
                  style={{
                    opacity: isActive ? 1 : (tile.opacity || MIN_OPACITY),
                    filter: debugMode 
                      ? 'brightness(0) contrast(1)' // Черные прямоугольники в режиме отладки
                      : `brightness(${IMAGE_BRIGHTNESS}) saturate(${IMAGE_SATURATE})`,
                    transition: 'opacity 0.3s ease',
                    ...(debugMode && {
                      border: '1px solid rgba(255, 255, 255, 0.3)', // Белая рамка для визуализации
                      boxSizing: 'border-box'
                    })
                  }}
                />
              </div>
            );
          })}
        </div>

        <div className={`transition-overlay ${transitioning ? 'active' : ''}`} />
        </div>

        <button
          className="nav-button nav-button-right"
          onClick={() => changeSlide('next')}
          aria-label="Следующее фото"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>
      </div>

      <div className="photo-indicator">
        {slideshowPhotos.slice(0, 15).map((_, index) => (
          <div
            key={index}
            className={`indicator-dot ${index === currentMainIndex ? 'active' : ''}`}
            onClick={() => handleIndicatorClick(index)}
            title={`Фото ${index + 1}`}
          />
        ))}
        {slideshowPhotos.length > 15 && (
          <span className="indicator-more">+{slideshowPhotos.length - 15}</span>
        )}
        <button
          onClick={downloadHighRes}
          disabled={isGeneratingHighRes || tiles.length === 0}
          style={{
            marginLeft: '20px',
            fontSize: '2em',
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            cursor: isGeneratingHighRes || tiles.length === 0 ? 'not-allowed' : 'pointer',
            opacity: isGeneratingHighRes || tiles.length === 0 ? 0.6 : 1,
            transition: 'background-color 0.3s ease',
          }}
          title={isGeneratingHighRes ? 'Генерация...' : 'Скачать в высоком разрешении для печати'}
        >
          {isGeneratingHighRes ? '⏳ Генерация...' : '⬇️'}
        </button>
      </div>
    </div>
  );
}

export default App;
