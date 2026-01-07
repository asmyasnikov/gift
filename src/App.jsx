import { useState, useEffect, useRef, useCallback } from 'react';
import { config } from '@/config.js';

// Порог вариации цвета для дробления области
// Максимальный размер канваса для анализа (по большей стороне)
const MAX_CANVAS_SIZE = 512;


// Константа для увеличения тайла при наведении/клике
const TILE_HOVER_SCALE = 5; // Масштаб увеличения тайла (1.0 = без увеличения, 2.0 = в 2 раза, и т.д.)

// Константа для максимального количества использований одного тайла
const MAX_TILE_USAGE = 2; // Максимальное количество раз, которое один тайл может быть использован

// Константы для шестиугольной сетки (пчелиных сот)
// Множитель для расстояния между центрами по горизонтали: sqrt(3) для правильной упаковки
const HEXAGON_HORIZONTAL_SPACING_MULTIPLIER = Math.sqrt(3)+0.05;
// Множитель для расстояния между рядами по вертикали: 1.5 для правильной упаковки
const HEXAGON_VERTICAL_SPACING_MULTIPLIER = 1.55;







// Функции для работы с шестиугольниками (пчелиными сотами)

// Вычисляет размер грани шестиугольника на основе площади
// S_соты - площадь одной соты
// Возвращает размер грани a
function calculateHexagonSideFromArea(hexArea) {
  // Площадь правильного шестиугольника: S = (3 * sqrt(3) / 2) * a^2
  // Отсюда: a = sqrt(2 * S / (3 * sqrt(3)))
  const a = Math.sqrt(2 * hexArea / (3 * Math.sqrt(3)));
  return a;
}

// Вычисляет координаты вершин правильного шестиугольника
// centerX, centerY - координаты центра
// side - размер грани
// Возвращает массив из 6 точек {x, y}
function getHexagonVertices(centerX, centerY, side) {
  const vertices = [];
  // Угол поворота для правильного шестиугольника: 60 градусов = π/3
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6; // Начинаем с верхней точки
    const x = centerX + side * Math.cos(angle);
    const y = centerY + side * Math.sin(angle);
    vertices.push({ x, y });
  }
  return vertices;
}

// Вычисляет clip-path строку для CSS из вершин шестиугольника
function getHexagonClipPath(vertices) {
  const points = vertices.map(v => `${v.x}px ${v.y}px`).join(', ');
  return `polygon(${points})`;
}

// Вычисляет диаметр вписанной окружности (расстояние от центра до грани)
function getHexagonInscribedDiameter(side) {
  return side * Math.sqrt(3);
}

// Вычисляет диаметр описанной окружности (расстояние от центра до вершины)
function getHexagonCircumscribedDiameter(side) {
  return 2 * side;
}

// Генерирует координаты центров шестиугольников в виде пчелиных сот
// width, height - размеры области
// side - размер грани шестиугольника
// Возвращает массив центров {x, y}
function generateHexagonGrid(width, height, side) {
  const centers = [];
  
  // Проверяем валидность входных данных
  if (width <= 0 || height <= 0 || side <= 0) {
    console.warn('[WARN] generateHexagonGrid: невалидные параметры', { width, height, side });
    return centers;
  }
  
  // Для правильной упаковки шестиугольников (пчелиных сот):
  // Расстояние между центрами по горизонтали в одном ряду
  const horizontalSpacing = HEXAGON_HORIZONTAL_SPACING_MULTIPLIER * side;
  // Расстояние по вертикали между рядами
  const verticalSpacing = HEXAGON_VERTICAL_SPACING_MULTIPLIER * side;
  
  // Радиус описанной окружности (расстояние от центра до вершины)
  const circumscribedRadius = side;
  
  // Начинаем с отступом от края (чтобы шестиугольник не выходил за границы)
  let row = 0;
  let y = circumscribedRadius;
  
  // Генерируем центры по правилу: рисовать соту, если верхняя точка попадает в область
  // Верхняя точка шестиугольника находится на расстоянии side (circumscribedRadius) от центра вверх
  // То есть если центр в (x, y), то верхняя точка в (x, y - side)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Вычисляем верхнюю точку следующего ряда
    const nextY = y + verticalSpacing;
    const nextTopY = nextY - circumscribedRadius;
    
    // Если верхняя точка следующего ряда не попадает в область (вышла за нижнюю границу), останавливаемся
    if (nextTopY >= height) {
      break;
    }
    
    // Для нечетных рядов сдвигаем вправо на половину горизонтального расстояния
    const offsetX = (row % 2 === 1) ? horizontalSpacing / 2 : 0;
    let x = circumscribedRadius + offsetX;
    
    // Используем небольшой запас для включения последнего столбца
    while (x <= width - circumscribedRadius + 0.5) {
      centers.push({ x, y });
      x += horizontalSpacing;
    }
    
    row++;
    y = nextY;
  }
  
  return centers;
}

// Проверяет, находится ли точка внутри шестиугольника
function isPointInHexagon(pointX, pointY, centerX, centerY, side) {
  const dx = pointX - centerX;
  const dy = pointY - centerY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const circumscribedRadius = side; // Радиус описанной окружности
  
  // Если точка вне описанной окружности, она точно снаружи
  if (distance > circumscribedRadius + 0.1) return false; // Небольшой запас для погрешности
  
  // Получаем вершины шестиугольника
  const vertices = getHexagonVertices(centerX, centerY, side);
  
  // Используем алгоритм ray casting для проверки попадания точки в многоугольник
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    
    const intersect = ((yi > pointY) !== (yj > pointY)) &&
      (pointX < (xj - xi) * (pointY - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  
  return inside;
}

// Вычисляет средний цвет области в форме шестиугольника
function getHexagonAreaColor(imageData, centerX, centerY, side, canvasWidth) {
  let sumR = 0, sumG = 0, sumB = 0;
  let count = 0;
  
  // Ограничиваем область поиска описанным квадратом
  const searchRadius = side;
  const startX = Math.max(0, Math.floor(centerX - searchRadius));
  const startY = Math.max(0, Math.floor(centerY - searchRadius));
  const endX = Math.min(canvasWidth, Math.ceil(centerX + searchRadius));
  const endY = Math.min(imageData.height, Math.ceil(centerY + searchRadius));
  
  for (let py = startY; py < endY; py++) {
    for (let px = startX; px < endX; px++) {
      if (isPointInHexagon(px, py, centerX, centerY, side)) {
        const idx = (py * canvasWidth + px) * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        
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
  
  if (isNaN(avgR) || isNaN(avgG) || isNaN(avgB)) {
    return { r: 128, g: 128, b: 128 };
  }
  
  return { r: avgR, g: avgG, b: avgB };
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





// Находит наиболее подходящее фото по цвету с учетом разнообразия и ограничений использования
function findBestMatch(targetColor, photoColors, usageCount, excludedIndices = new Set(), diversityBonus = 5000, debugInfo = null, availableTileIndices = null, maxUsage = MAX_TILE_USAGE) {
  // Сначала находим все кандидаты с их расстояниями
  const candidates = [];
  
  photoColors.forEach((color, index) => {
    // Пропускаем исключенные индексы (например, главное фото)
    if (excludedIndices.has(index)) {
      return;
    }
    
    // Пропускаем индексы, для которых нет тайла (если передан список доступных)
    if (availableTileIndices && !availableTileIndices.has(index)) {
      return;
    }
    
    const usage = usageCount.get(index) || 0;
    
    // Пропускаем тайлы, которые уже использованы максимальное количество раз
    if (usage >= maxUsage) {
      return;
    }
    
    const originalDistance = colorDistance(targetColor, color);
    
    // Применяем экспоненциальный штраф за использование
    // Чем больше использований, тем экспоненциально больше штраф
    // Также добавляем большой штраф, если тайл еще не использован (чтобы сначала использовать все тайлы хотя бы раз)
    const unusedPenalty = usage === 0 ? -diversityBonus * 0.5 : 0; // Бонус за неиспользованные тайлы
    const usagePenalty = usage > 0 ? diversityBonus * (1 + Math.pow(usage, 1.5)) : 0;
    const distance = originalDistance + usagePenalty - unusedPenalty;
    
    candidates.push({ index, distance, usage, originalDistance });
  });
  
  // Если нет кандидатов, пытаемся найти любой доступный тайл
  if (candidates.length === 0) {
    console.warn('[DEBUG] findBestMatch: нет кандидатов!', {
      targetColor,
      totalPhotoColors: photoColors.length,
      excludedIndices: Array.from(excludedIndices),
      availableTileIndices: availableTileIndices ? Array.from(availableTileIndices) : null,
      availableTileIndicesSize: availableTileIndices ? availableTileIndices.size : null,
      debugInfo: debugInfo ? { tileIndex: debugInfo.tileIndex } : null
    });
    
    // Если передан список доступных тайлов, выбираем первый доступный
    if (availableTileIndices && availableTileIndices.size > 0) {
      const firstAvailable = Array.from(availableTileIndices).find(idx => !excludedIndices.has(idx));
      if (firstAvailable !== undefined) {
        console.log(`[DEBUG] findBestMatch: используем fallback - первый доступный индекс ${firstAvailable}`);
        return firstAvailable;
      } else {
        console.warn('[DEBUG] findBestMatch: все доступные тайлы исключены!', {
          availableIndices: Array.from(availableTileIndices),
          excludedIndices: Array.from(excludedIndices)
        });
      }
    } else {
      console.warn('[DEBUG] findBestMatch: availableTileIndices пуст или не передан!');
    }
    // Fallback на 0, если ничего не найдено
    console.warn(`[DEBUG] findBestMatch: используем fallback - индекс 0`);
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


function App() {
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [photoIndex, setPhotoIndex] = useState(null);
  const [images, setImages] = useState([]);
  const [photoColors, setPhotoColors] = useState([]);
  const [slideshowPhotos, setSlideshowPhotos] = useState([]);
  const [currentMainIndex, setCurrentMainIndex] = useState(0);
  const [tiles, setTiles] = useState([]);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [mainImageSize, setMainImageSize] = useState({ width: 0, height: 0, x: 0, y: 0 });
  const [mainImageUrl, setMainImageUrl] = useState(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [isGeneratingHighRes, setIsGeneratingHighRes] = useState(false);
  const [hoveredTileIndex, setHoveredTileIndex] = useState(null);
  const [tileImageUrls, setTileImageUrls] = useState({}); // Кэш URL'ов тайлов (объект для React state)
  const [mainPhotoUrls, setMainPhotoUrls] = useState({}); // Кэш URL'ов главных фото
  const [availableTileIndices, setAvailableTileIndices] = useState(new Set()); // Индексы фото, для которых есть тайлы
  const [tilesLoaded, setTilesLoaded] = useState(false); // Флаг, что все тайлы загружены и проверены

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
        // Ищем фото по имени файла без расширения
        const photoIndex = slideshowPhotos.findIndex(photo => {
          const baseName = photo.filename.replace(/\.(jpg|jpeg|png|heic)$/i, '');
          return baseName === photoParam;
        });
        if (photoIndex !== -1) {
          setCurrentMainIndex(photoIndex);
        }
      } else {
        // Если параметра нет, устанавливаем его в URL с именем первого фото
        const params = new URLSearchParams(window.location.search);
        const firstPhoto = slideshowPhotos[0];
        if (firstPhoto) {
          const baseName = firstPhoto.filename.replace(/\.(jpg|jpeg|png|heic)$/i, '');
          params.set('photo', baseName);
          window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
        }
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
        
        // Проверяем PNG файлы - это главные фото
        // PNG файл сам является маской (прозрачные части = тайлы видны, непрозрачные = тайлы не видны)
        const slideshowList = [];
        
        if (debugMode) {
          console.log('[DEBUG] Проверка PNG файлов (главные фото)...', {
            totalPhotos: data.photos.length
          });
        }
        
        // Проверяем PNG файлы - это главные фото
        data.photos.forEach((photo) => {
          const ext = photo.filename.toLowerCase();
          // Главные фото - это PNG файлы
          if (ext.endsWith('.png')) {
            slideshowList.push(photo);
            if (debugMode) {
              console.log('[DEBUG] Главное фото найдено (PNG):', photo.filename);
            }
          }
        });
        
        console.log('[DEBUG] Фото в слайд-шоу (PNG файлы):', {
          totalPhotos: data.photos.length,
          pngPhotos: slideshowList.length,
          photos: slideshowList.map(p => p.filename),
          allExtensions: [...new Set(data.photos.map(p => p.filename.split('.').pop().toLowerCase()))]
        });
        
        if (slideshowList.length === 0) {
          console.warn('[WARN] Не найдено PNG файлов в index.json! Все файлы должны быть PNG для главных фото.');
        }
        
        setSlideshowPhotos(slideshowList);
      })
      .catch(err => {
        console.error('Ошибка загрузки index.json:', err);
      });
  }, [debugMode]);

  // Предзагружаем все главные фото и маски через кэш
  useEffect(() => {
    if (slideshowPhotos.length === 0) return;

    const preloadMainPhotos = async () => {
      const newMainPhotoUrls = {};
      
      if (debugMode) {
        console.log('[DEBUG] Начинаем предзагрузку главных фото:', {
          count: slideshowPhotos.length
        });
      }

      // Загружаем все главные фото (PNG файлы) параллельно
      const loadPromises = slideshowPhotos.map(async (photo) => {
        const photoUrl = `/photos/${photo.filename}`;
        
        // Используем прямые URL - браузер сам закэширует изображения
        newMainPhotoUrls[photo.filename] = photoUrl;
      });
      
      await Promise.all(loadPromises);
      setMainPhotoUrls(newMainPhotoUrls);
      
      if (debugMode) {
        console.log('[DEBUG] Предзагрузка главных фото (PNG) завершена:', {
          photosLoaded: Object.keys(newMainPhotoUrls).length,
          totalPhotos: slideshowPhotos.length
        });
      }
    };

    preloadMainPhotos();
  }, [slideshowPhotos, debugMode]);

  // Загружаем изображения после получения индекса и предзагружаем все тайлы
  useEffect(() => {
    if (!photoIndex) return;
    // Ждем, пока slideshowPhotos будет загружен (может быть пустым массивом, но должен быть установлен)
    // slideshowPhotos устанавливается в том же useEffect, где загружается photoIndex, но асинхронно
    // Поэтому нужно подождать следующего тика, чтобы slideshowPhotos был установлен
    // Но на самом деле slideshowPhotos устанавливается синхронно в том же useEffect, так что это не проблема
    // Однако, если slideshowPhotos еще не установлен (undefined), то нужно подождать

    const loadImages = async () => {
      // Сбрасываем флаг загрузки тайлов при новой загрузке
      setTilesLoaded(false);
      setLoadingProgress('Загрузка изображений...');

      const loadedImages = [];
      const colors = [];
      const photos = photoIndex.photos;

      // Используем пропорции из index.json (быстрее, чем загружать все изображения)
      photos.forEach(photo => {
        colors.push(photo.avgColor);
        loadedImages.push({ filename: photo.filename });
      });

      setImages(loadedImages);
      setPhotoColors(colors);
      
      // Предзагружаем все тайлы из /photos/ (все файлы из index.json)
      // Главные фото (PNG файлы) НЕ могут быть тайлами - исключаем их из списка доступных
      setLoadingProgress('Предзагрузка тайлов...');
      
      // Создаем Set имен файлов главных фото (PNG файлы) для быстрой проверки
      // Используем текущее значение slideshowPhotos из замыкания
      const mainPhotoFilenames = new Set(slideshowPhotos.map(photo => photo.filename));
      
      // Предзагружаем все тайлы из /photos/ и проверяем их существование
      // Создаем Set доступных индексов тайлов
      const availableIndices = new Set();
      const missingTiles = [];
      const tilePromises = photos.map(async (photo, index) => {
        // Пропускаем главные фото (PNG файлы) - они не могут быть тайлами
        if (mainPhotoFilenames.has(photo.filename)) {
          if (debugMode) {
            console.log(`[DEBUG] Пропуск главного фото (не может быть тайлом): index=${index}, filename=${photo.filename}`);
          }
          return;
        }
        
        const tileUrl = `/photos/${photo.filename}`;
        // Проверяем существование тайла через HEAD запрос
        try {
          const response = await fetch(tileUrl, { method: 'HEAD' });
          if (response.ok) {
            // Тайл существует - добавляем индекс в список доступных
            availableIndices.add(index);
            if (debugMode) {
              console.log(`[DEBUG] Тайл найден: index=${index}, filename=${photo.filename}`);
            }
          } else {
            missingTiles.push({ index, filename: photo.filename });
            if (debugMode) {
              console.warn(`[DEBUG] Тайл НЕ найден: index=${index}, filename=${photo.filename}, url=${tileUrl}`);
            }
          }
        } catch (error) {
          // Ошибка сети - считаем что тайл не найден
          missingTiles.push({ index, filename: photo.filename });
          if (debugMode) {
            console.warn(`[DEBUG] Тайл НЕ найден (ошибка сети): index=${index}, filename=${photo.filename}, url=${tileUrl}`);
          }
        }
      });
      
      // Ждем завершения загрузки всех тайлов
      await Promise.all(tilePromises);
      
      // Сохраняем список доступных индексов тайлов
      setAvailableTileIndices(availableIndices);
      
      // Устанавливаем флаг, что все тайлы загружены и проверены
      setTilesLoaded(true);
      
      const excludedMainPhotos = slideshowPhotos.length;
      console.log('[DEBUG] Все тайлы предзагружены и проверены', {
        totalPhotos: photos.length,
        tilesPreloaded: tilePromises.length,
        availableTiles: availableIndices.size,
        excludedMainPhotos: excludedMainPhotos,
        missingTiles: photos.length - availableIndices.size - excludedMainPhotos,
        availableIndices: Array.from(availableIndices).sort((a, b) => a - b),
        missingTilesList: missingTiles.map(t => `${t.index}:${t.filename}`),
        mainPhotoFilenames: Array.from(mainPhotoFilenames),
        allPhotoFilenames: photos.map(p => p.filename)
      });
      
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
  }, [photoIndex, slideshowPhotos, debugMode]);

  // Вычисляем размер контейнера на основе доступного пространства
  // Используем visualViewport API для точного определения размера на мобильных устройствах
  useEffect(() => {
    const updateSize = () => {
      if (debugMode) {
        console.log('[DEBUG] updateSize вызван');
      }
      
      // Используем visualViewport API если доступен (для точного размера на мобильных, особенно iPhone)
      // visualViewport дает реальный размер видимой области, учитывая адресную строку браузера
      let vw, vh;
      
      if (window.visualViewport) {
        vw = window.visualViewport.width;
        vh = window.visualViewport.height;
        
        if (debugMode) {
          console.log('[DEBUG] Используется visualViewport:', { 
            width: vw, 
            height: vh,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            scale: window.visualViewport.scale
          });
        }
      } else {
        // Fallback на стандартные методы
        vw = window.innerWidth;
        vh = window.innerHeight;
        
        if (debugMode) {
          console.log('[DEBUG] Используется window.innerWidth/Height:', { width: vw, height: vh });
        }
      }

      // Оставляем место для заголовка и индикаторов
      // Заголовок: padding-top (10px) + font-size (до 2.5rem = 40px) + margin-bottom (1rem = 16px) + небольшой запас
      const headerHeight = 100; // Увеличено для учета реальной высоты заголовка
      const indicatorHeight = 50; // Увеличено для учета отступов
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
        console.log('[DEBUG] containerSize обновлен:', { 
          width: containerWidth, 
          height: containerHeight,
          viewport: { width: vw, height: vh },
          available: { width: availableWidth, height: availableHeight }
        });
      }
      setContainerSize({ width: containerWidth, height: containerHeight });
    };

    updateSize();
    
    // Обработчики для обновления размера
    window.addEventListener('resize', updateSize);
    
    // visualViewport события для мобильных устройств (особенно iPhone)
    // Эти события срабатывают при изменении размера видимой области (скрытие/появление адресной строки)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateSize);
      window.visualViewport.addEventListener('scroll', updateSize);
      
      return () => {
        window.removeEventListener('resize', updateSize);
        window.visualViewport.removeEventListener('resize', updateSize);
        window.visualViewport.removeEventListener('scroll', updateSize);
      };
    }
    
    return () => window.removeEventListener('resize', updateSize);
  }, [debugMode]);

  // Генерируем мозаику
  const generateMosaic = useCallback(async () => {
    // Не генерируем мозаику, если тайлы еще не загружены и проверены
    if (images.length === 0 || slideshowPhotos.length === 0 || !containerSize.width || !tilesLoaded || availableTileIndices.size === 0) {
      console.log('[DEBUG] generateMosaic пропущен:', {
        imagesLength: images.length,
        slideshowPhotosLength: slideshowPhotos.length,
        containerWidth: containerSize.width,
        tilesLoaded,
        availableTilesCount: availableTileIndices.size,
        slideshowPhotos: slideshowPhotos.map(p => p.filename)
      });
      return;
    }
    
    if (debugMode) {
      console.log('[DEBUG] generateMosaic вызван', {
        imagesCount: images.length,
        slideshowPhotosCount: slideshowPhotos.length,
        containerSize,
        currentMainIndex,
        availableTilesCount: availableTileIndices.size,
        tilesLoaded
      });
    }

    const currentPhoto = slideshowPhotos[currentMainIndex];
    
    // Загружаем основное фото (PNG) через кэш
    const mainImage = new Image();
    mainImage.crossOrigin = 'anonymous';
    
    try {
      // Используем кэшированный URL если доступен
      const photoUrl = `/photos/${currentPhoto.filename}`;
      const cachedPhotoUrl = mainPhotoUrls[currentPhoto.filename] || photoUrl;
      
      await new Promise((resolve, reject) => {
        mainImage.onload = resolve;
        mainImage.onerror = reject;
        mainImage.src = cachedPhotoUrl;
      });
    } catch (e) {
      console.error('Ошибка загрузки основного фото:', currentPhoto.filename);
      return;
    }
    
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;

    // Вычисляем пропорции изображения
    const imgAspect = mainImage.naturalWidth / mainImage.naturalHeight;
    
    // Устанавливаем URL основного фото для фона (используем кэшированный URL)
    const photoUrl = `/photos/${currentPhoto.filename}`;
    const cachedPhotoUrl = mainPhotoUrls[currentPhoto.filename] || photoUrl;
    setMainImageUrl(cachedPhotoUrl);

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
    
    // Временно сохраняем исходные размеры для вычисления a
    const originalMainImgWidth = mainImgWidth;
    const originalMainImgHeight = mainImgHeight;

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

    // Строим Quadtree только для области, где нарисовано изображение
    // Это важно, чтобы тайлы покрывали всю область основного изображения
    const imageAreaWidth = drawWidth;
    const imageAreaHeight = drawHeight;
    
    // Создаем новый canvas только для области изображения
    const imageAreaCanvas = document.createElement('canvas');
    imageAreaCanvas.width = imageAreaWidth;
    imageAreaCanvas.height = imageAreaHeight;
    const imageAreaCtx = imageAreaCanvas.getContext('2d');
    
    // Копируем область изображения на новый canvas
    imageAreaCtx.drawImage(mainImage, 0, 0, imageAreaWidth, imageAreaHeight);
    const imageAreaData = imageAreaCtx.getImageData(0, 0, imageAreaWidth, imageAreaHeight);

    // Масштаб от области изображения на canvas к размеру главного фото в контейнере
    const scaleX = mainImgWidth / imageAreaWidth;
    const scaleY = mainImgHeight / imageAreaHeight;

    // Главные фото (с PNG масками) уже исключены из availableTileIndices при формировании списка
    // Но для дополнительной надежности исключаем текущее главное фото (на случай, если оно попало в список)
    const currentMainPhotoIndex = images.findIndex(img => img.filename === currentPhoto.filename);
    const excludedIndices = new Set();
    if (currentMainPhotoIndex !== -1) {
      excludedIndices.add(currentMainPhotoIndex);
    }

    // Проверяем, что photoIndex и photos существуют
    if (!photoIndex || !photoIndex.photos) {
      console.error('[ERROR] photoIndex или photos не определены');
      return;
    }
    
    const photos = photoIndex.photos;
    
    // Проверяем, что есть доступные тайлы
    if (availableTileIndices.size === 0) {
      console.error('[ERROR] Нет доступных тайлов', {
        totalPhotos: photos.length,
        slideshowPhotosCount: slideshowPhotos.length,
        mainPhotoFilenames: slideshowPhotos.map(p => p.filename),
        availableTileIndicesSize: availableTileIndices.size
      });
      return;
    }
    
    // Вычисляем параметры для шестиугольной сетки (пчелиных сот)
    const totalTiles = availableTileIndices.size;
    
    // Площадь области mosaic-tiles (весь контейнер)
    const S_общая = containerSize.width * containerSize.height;
    
    // Количество тайлов
    const N = totalTiles;
    
    // Площадь одной соты
    const S_соты = S_общая / N;
    
    // Размер грани шестиугольника
    // Площадь правильного шестиугольника: S = (3 * sqrt(3) / 2) * a^2
    // Отсюда: a = sqrt(2 * S / (3 * sqrt(3)))
    let a = calculateHexagonSideFromArea(S_соты);
    
    // Проверяем, что размер грани не слишком большой (не больше 1/4 от меньшей стороны контейнера)
    const maxSide = Math.min(containerSize.width, containerSize.height) / 4;
    if (a > maxSide) {
      console.warn('[WARN] Размер грани слишком большой, ограничиваем:', { a, maxSide });
      a = maxSide;
    }
    
    // Проверяем, что размер грани не слишком маленький (минимум 10px)
    const minSide = 10;
    if (a < minSide) {
      console.warn('[WARN] Размер грани слишком маленький, увеличиваем:', { a, minSide });
      a = minSide;
    }
    
    // Диаметр вписанной окружности (расстояние от центра до грани)
    const d_вписанная = getHexagonInscribedDiameter(a);
    
    // Диаметр описанной окружности (расстояние от центра до вершины)
    const d_описанная = getHexagonCircumscribedDiameter(a);
    
    // Уменьшаем главное фото на размер грани `a`, чтобы минимум один ряд сот был вокруг
    // Уменьшаем ширину и высоту на `a`, и центрируем
    mainImgWidth = Math.max(0, originalMainImgWidth);
    mainImgHeight = Math.max(0, originalMainImgHeight);
    mainImgX = (containerSize.width - mainImgWidth) / 2;
    mainImgY = (containerSize.height - mainImgHeight) / 2;
    
    // Обновляем размер главного фото в состоянии
    setMainImageSize({ width: mainImgWidth, height: mainImgHeight, x: mainImgX, y: mainImgY });
    
    if (debugMode) {
      console.log('[DEBUG] Вычисление параметров шестиугольной сетки:', {
        totalTiles: N,
        S_общая,
        S_соты,
        размер_грани: a,
        диаметр_вписанной: d_вписанная,
        диаметр_описанной: d_описанная,
        containerSize: { width: containerSize.width, height: containerSize.height },
        originalMainImgSize: { width: originalMainImgWidth, height: originalMainImgHeight },
        mainImgSize: { width: mainImgWidth, height: mainImgHeight, x: mainImgX, y: mainImgY }
      });
    }
    
    // Генерируем сетку центров шестиугольников для всего контейнера
    const hexagonCenters = generateHexagonGrid(containerSize.width, containerSize.height, a);
    
    if (hexagonCenters.length === 0) {
      console.error('[ERROR] Не удалось сгенерировать центры шестиугольников:', {
        containerWidth: containerSize.width,
        containerHeight: containerSize.height,
        a,
        d_описанная
      });
      return;
    }
    
    // Ограничиваем количество центров количеством доступных тайлов
    const centersToUse = hexagonCenters.slice(0, Math.min(totalTiles, hexagonCenters.length));
    
    if (debugMode) {
      console.log('[DEBUG] Сгенерировано центров шестиугольников:', {
        всего_центров: hexagonCenters.length,
        используется: centersToUse.length,
        доступно_тайлов: totalTiles
      });
    }
    
    if (centersToUse.length === 0) {
      console.error('[ERROR] Нет центров для размещения тайлов');
      return;
    }
    
    // Создаём плитки в виде шестиугольников
    // Используем Map для подсчета использований каждого фото
    const usageCount = new Map();
    
    
    // Генерируем плитки для всего контейнера в виде шестиугольной сетки
    const allTiles = [];
    
    // Обрабатываем каждый центр шестиугольника
    centersToUse.forEach((center, index) => {
      try {
        // Координаты центра в системе координат контейнера
        const centerX = center.x;
        const centerY = center.y;
        
        // Проверяем, попадает ли центр на главное фото
        const isOnMainImage = centerX >= mainImgX && 
                             centerX <= mainImgX + mainImgWidth &&
                             centerY >= mainImgY && 
                             centerY <= mainImgY + mainImgHeight;
        
        let tileColor;
        
        if (isOnMainImage) {
          // Если попадает на главное фото - используем цвет из главного фото
          // Координаты центра относительно главного фото
          const relativeX = centerX - mainImgX;
          const relativeY = centerY - mainImgY;
          
          // Координаты центра в системе координат canvas для анализа цвета
          const centerCanvasX = relativeX / scaleX;
          const centerCanvasY = relativeY / scaleY;
          
          // Получаем средний цвет области в форме шестиугольника из главного фото
          tileColor = getHexagonAreaColor(
            imageAreaData,
            centerCanvasX,
            centerCanvasY,
            a / scaleX, // Масштабируем размер грани для canvas
            imageAreaWidth
          );
        } else {
          // Если не попадает на главное фото - используем случайный цвет из краев
          tileColor = edgeColorSamples[Math.floor(Math.random() * edgeColorSamples.length)];
        }
        
        // Выбираем тайл на основе цвета области
        const bestIndex = findBestMatch(
          tileColor,
          photoColors,
          usageCount,
          excludedIndices,
          5000,
          { debugMode, tileIndex: index },
          availableTileIndices,
          MAX_TILE_USAGE
        );
        
        if (bestIndex === null || bestIndex === undefined) {
          console.warn(`[WARN] Не удалось найти тайл для центра ${index}:`, { center, tileColor });
          return;
        }
        
        // Увеличиваем счетчик использования
        usageCount.set(bestIndex, (usageCount.get(bestIndex) || 0) + 1);
        
        // Вычисляем вершины шестиугольника для clip-path
        const vertices = getHexagonVertices(centerX, centerY, a);
        
        // Вычисляем границы для позиционирования (описанный прямоугольник)
        const minX = Math.min(...vertices.map(v => v.x));
        const maxX = Math.max(...vertices.map(v => v.x));
        const minY = Math.min(...vertices.map(v => v.y));
        const maxY = Math.max(...vertices.map(v => v.y));
        
        const tileWidth = maxX - minX;
        const tileHeight = maxY - minY;
        
        allTiles.push({
          x: minX,
          y: minY,
          width: tileWidth,
          height: tileHeight,
          centerX: centerX,
          centerY: centerY,
          hexSide: a,
          vertices: vertices,
          imageIndex: bestIndex,
          avgColor: tileColor,
          opacity: 1.0, // Тайлы всегда рисуются с полной непрозрачностью
          isOnMainImage, // Сохраняем информацию о том, попадает ли тайл на главное фото
        });
      } catch (error) {
        console.error(`[ERROR] Ошибка при создании тайла для центра ${index}:`, error, { center });
      }
    });
    
    if (allTiles.length === 0) {
      console.error('[ERROR] Не создано ни одного тайла!', {
        centersToUseLength: centersToUse.length,
        containerSize,
        mainImgX,
        mainImgY,
        mainImgWidth,
        mainImgHeight,
        a,
        scaleX,
        scaleY,
        imageAreaWidth,
        imageAreaHeight
      });
      return;
    }
    
    // Используем все тайлы как основные (больше не разделяем на mainImageTiles и backgroundTiles)
    const mainImageTiles = allTiles;
    
    // Убеждаемся, что все доступные тайлы используются хотя бы один раз
    // Находим тайлы, которые еще не использованы
    const unusedTileIndices = Array.from(availableTileIndices).filter(
      idx => !excludedIndices.has(idx) && (usageCount.get(idx) || 0) === 0
    );
    
    if (unusedTileIndices.length > 0 && debugMode) {
      console.log('[DEBUG] Найдены неиспользованные тайлы:', {
        count: unusedTileIndices.length,
        indices: unusedTileIndices
      });
    }
    
    // Теперь весь контейнер покрыт сотами, дополнительное заполнение не требуется
    
    const newTiles = mainImageTiles;

    // Проверяем, что все индексы тайлов есть в availableTileIndices
    const usedIndices = new Set(newTiles.map(tile => tile.imageIndex));
    const missingIndices = Array.from(usedIndices).filter(idx => !availableTileIndices.has(idx));
    
    console.log('[DEBUG] Мозаика сгенерирована - проверка индексов:', {
      totalTiles: newTiles.length,
      uniqueImageIndices: usedIndices.size,
      usedIndices: Array.from(usedIndices).sort((a, b) => a - b),
      availableTileIndices: Array.from(availableTileIndices).sort((a, b) => a - b),
      missingIndices: missingIndices.length > 0 ? missingIndices : 'Нет проблемных индексов',
      excludedIndices: Array.from(excludedIndices)
    });
    
    if (missingIndices.length > 0) {
      console.error('[DEBUG] ОШИБКА: Найдены тайлы с индексами, которых нет в availableTileIndices!', {
        missingIndices,
        tilesWithMissingIndices: newTiles.filter(tile => missingIndices.includes(tile.imageIndex)).map(tile => ({
          imageIndex: tile.imageIndex,
          filename: images[tile.imageIndex]?.filename
        }))
      });
    }

    if (debugMode) {
      // Проверяем покрытие области основного изображения тайлами
      const mainImageTilesCoverage = {
        minX: Math.min(...mainImageTiles.map(t => t.x)),
        maxX: Math.max(...mainImageTiles.map(t => t.x + t.width)),
        minY: Math.min(...mainImageTiles.map(t => t.y)),
        maxY: Math.max(...mainImageTiles.map(t => t.y + t.height)),
      };
      
      const expectedMainImageCoverage = {
        minX: mainImgX,
        maxX: mainImgX + mainImgWidth,
        minY: mainImgY,
        maxY: mainImgY + mainImgHeight,
      };
      
      // Проверяем пропуски
      const gaps = [];
      const tolerance = 1; // Допустимый зазор в пикселях
      
      // Проверяем покрытие по X
      if (Math.abs(mainImageTilesCoverage.minX - expectedMainImageCoverage.minX) > tolerance) {
        gaps.push({
          type: 'left_edge',
          expected: expectedMainImageCoverage.minX,
          actual: mainImageTilesCoverage.minX,
          gap: mainImageTilesCoverage.minX - expectedMainImageCoverage.minX
        });
      }
      if (Math.abs(mainImageTilesCoverage.maxX - expectedMainImageCoverage.maxX) > tolerance) {
        gaps.push({
          type: 'right_edge',
          expected: expectedMainImageCoverage.maxX,
          actual: mainImageTilesCoverage.maxX,
          gap: expectedMainImageCoverage.maxX - mainImageTilesCoverage.maxX
        });
      }
      if (Math.abs(mainImageTilesCoverage.minY - expectedMainImageCoverage.minY) > tolerance) {
        gaps.push({
          type: 'top_edge',
          expected: expectedMainImageCoverage.minY,
          actual: mainImageTilesCoverage.minY,
          gap: mainImageTilesCoverage.minY - expectedMainImageCoverage.minY
        });
      }
      if (Math.abs(mainImageTilesCoverage.maxY - expectedMainImageCoverage.maxY) > tolerance) {
        gaps.push({
          type: 'bottom_edge',
          expected: expectedMainImageCoverage.maxY,
          actual: mainImageTilesCoverage.maxY,
          gap: expectedMainImageCoverage.maxY - mainImageTilesCoverage.maxY
        });
      }
      
      console.log('[DEBUG] Мозаика сгенерирована:', {
        tilesCount: newTiles.length,
        mainImageTilesCount: mainImageTiles.length,
        opacityRange: {
          min: Math.min(...newTiles.map(t => t.opacity)),
          max: Math.max(...newTiles.map(t => t.opacity))
        },
        mainImageSize: {
          x: mainImgX,
          y: mainImgY,
          width: mainImgWidth,
          height: mainImgHeight
        },
        mainImageTilesCoverage,
        expectedMainImageCoverage,
        gaps: gaps.length > 0 ? gaps : 'Нет пропусков',
        scaleFactors: { scaleX, scaleY },
        imageAreaSize: { width: imageAreaWidth, height: imageAreaHeight }
      });
      
      // Логируем первые 10 тайлов для детального анализа
      if (mainImageTiles.length > 0) {
        console.log('[DEBUG] Первые 10 тайлов основного изображения:', 
          mainImageTiles.slice(0, 10).map((tile, idx) => ({
            index: idx,
            x: Math.round(tile.x * 100) / 100,
            y: Math.round(tile.y * 100) / 100,
            width: Math.round(tile.width * 100) / 100,
            height: Math.round(tile.height * 100) / 100,
            right: Math.round((tile.x + tile.width) * 100) / 100,
            bottom: Math.round((tile.y + tile.height) * 100) / 100,
            opacity: Math.round(tile.opacity * 100) / 100
          }))
        );
      }
      
      // Логируем последние 10 тайлов (особенно важно для проверки нижней части)
      if (mainImageTiles.length > 10) {
        console.log('[DEBUG] Последние 10 тайлов основного изображения:', 
          mainImageTiles.slice(-10).map((tile, idx) => ({
            index: mainImageTiles.length - 10 + idx,
            x: Math.round(tile.x * 100) / 100,
            y: Math.round(tile.y * 100) / 100,
            width: Math.round(tile.width * 100) / 100,
            height: Math.round(tile.height * 100) / 100,
            right: Math.round((tile.x + tile.width) * 100) / 100,
            bottom: Math.round((tile.y + tile.height) * 100) / 100,
            opacity: Math.round(tile.opacity * 100) / 100
          }))
        );
      }
    }
    
    setTiles(newTiles);
  }, [images, photoColors, slideshowPhotos, currentMainIndex, containerSize, debugMode, mainPhotoUrls, availableTileIndices, tilesLoaded, photoIndex]);

  // Регенерируем мозаику при смене параметров
  // Генерируем мозаику только после загрузки и проверки всех тайлов
  useEffect(() => {
    if (debugMode) {
      console.log('[DEBUG] useEffect для generateMosaic:', {
        loading,
        tilesLoaded,
        containerSize,
        currentMainIndex,
        availableTilesCount: availableTileIndices.size
      });
    }
    // Ждем завершения загрузки и проверяем, что тайлы загружены и проверены
    if (!loading && tilesLoaded && containerSize.width > 0 && availableTileIndices.size > 0) {
      generateMosaic();
      // Сбрасываем активный тайл при смене слайда
      setHoveredTileIndex(null);
    }
  }, [loading, tilesLoaded, currentMainIndex, generateMosaic, containerSize, debugMode, availableTileIndices]);

  // Предзагружаем тайлы через кэш при изменении tiles
  // Загружаем только те тайлы, которые существуют (проверяем через availableTileIndices)
  // Ждем, пока все тайлы будут проверены (tilesLoaded)
  useEffect(() => {
    if (tiles.length === 0 || images.length === 0 || !tilesLoaded || availableTileIndices.size === 0) return;

    const loadTiles = async () => {
      const newUrls = {};
      const uniqueImageIndices = new Set(tiles.map(tile => tile.imageIndex));
      const skippedIndices = [];
      const failedIndices = [];
      const loadedIndices = [];
      
      console.log('[DEBUG] Начинаем загрузку тайлов для рендеринга:', {
        totalTiles: tiles.length,
        uniqueImageIndices: Array.from(uniqueImageIndices).sort((a, b) => a - b),
        availableTileIndices: Array.from(availableTileIndices).sort((a, b) => a - b)
      });
      
      // Загружаем все уникальные тайлы через кэш
      // Проверяем, что тайл существует в availableTileIndices перед загрузкой
      const loadPromises = Array.from(uniqueImageIndices).map(async (imageIndex) => {
        // Пропускаем тайлы, которых нет в списке доступных
        if (!availableTileIndices.has(imageIndex)) {
          skippedIndices.push(imageIndex);
          console.warn(`[DEBUG] Пропуск тайла ${imageIndex} (${images[imageIndex]?.filename}) - не найден в availableTileIndices`);
          return;
        }
        
        const image = images[imageIndex];
        if (!image || !image.filename) {
          console.warn(`[DEBUG] Пропуск тайла ${imageIndex} - нет информации об изображении`);
          return;
        }
        
        const tileUrl = `/photos/${image.filename}`;
        
        // Используем прямой URL - браузер сам закэширует изображение
        newUrls[imageIndex] = tileUrl;
        loadedIndices.push(imageIndex);
        if (debugMode) {
          console.log(`[DEBUG] Тайл загружен: index=${imageIndex}, filename=${image.filename}`);
        }
      });
      
      await Promise.all(loadPromises);
      setTileImageUrls(newUrls);
      
      console.log('[DEBUG] Тайлы загружены через кэш:', {
        totalTiles: tiles.length,
        uniqueImages: uniqueImageIndices.size,
        availableTiles: Array.from(uniqueImageIndices).filter(idx => availableTileIndices.has(idx)).length,
        loadedTiles: loadedIndices.length,
        cachedUrls: Object.keys(newUrls).length,
        skippedIndices: skippedIndices.length > 0 ? skippedIndices : 'Нет пропущенных',
        failedIndices: failedIndices.length > 0 ? failedIndices : 'Нет неудачных',
        loadedIndices: loadedIndices.sort((a, b) => a - b)
      });
      
      if (skippedIndices.length > 0 || failedIndices.length > 0) {
        console.error('[DEBUG] ПРОБЛЕМЫ при загрузке тайлов:', {
          skippedIndices,
          failedIndices
        });
      }
    };

    loadTiles();
  }, [tiles, images, availableTileIndices, tilesLoaded, debugMode]);

  // Автоматическая смена основного фото каждые 5 секунд (только если autoPlay = true)
  useEffect(() => {
    if (loading || slideshowPhotos.length === 0 || !autoPlay) return;
    if (debugMode) {
      console.log('[DEBUG] Автопереключение слайда');
    }

    const interval = setInterval(() => {
      setTimeout(() => {
        setCurrentMainIndex(prev => (prev + 1) % slideshowPhotos.length);
      }, 500);
    }, 5000);

    return () => clearInterval(interval);
  }, [loading, slideshowPhotos.length, autoPlay, debugMode]);

  // Функция для переключения слайда
  const changeSlide = useCallback((direction) => {
    if (slideshowPhotos.length === 0) return;
    
    setTimeout(() => {
      let newIndex;
      if (direction === 'next') {
        newIndex = (currentMainIndex + 1) % slideshowPhotos.length;
      } else {
        newIndex = (currentMainIndex - 1 + slideshowPhotos.length) % slideshowPhotos.length;
      }
      
      setCurrentMainIndex(newIndex);
      
      // Обновляем URL с параметром photo (имя файла без расширения)
      const params = new URLSearchParams(window.location.search);
      const currentPhoto = slideshowPhotos[newIndex];
      if (currentPhoto) {
        const baseName = currentPhoto.filename.replace(/\.(jpg|jpeg|png|heic)$/i, '');
        params.set('photo', baseName);
        window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
      }
    }, 500);
  }, [slideshowPhotos, currentMainIndex]);

  // Генерация мозаики в высоком разрешении для печати
  const downloadHighRes = useCallback(async () => {
    if (tiles.length === 0 || !mainImageUrl || isGeneratingHighRes) return;
    
    setIsGeneratingHighRes(true);
    
    try {
      // Коэффициент масштабирования для высокого разрешения (300 DPI для печати)
      // Для плаката A2 (16.5x23.4 дюйма) при 300 DPI = 4950x7020 пикселей
      // Используем коэффициент 4x от текущего размера для баланса качества и размера файла
      const scaleFactor = 4;
      
      // Загружаем основное фото в высоком разрешении (используем кэш)
      const mainImg = new Image();
      mainImg.crossOrigin = 'anonymous';
      
      // Используем кэшированный URL если доступен
      const currentPhoto = slideshowPhotos[currentMainIndex];
      const cachedPhotoUrl = currentPhoto && mainPhotoUrls[currentPhoto.filename] 
        ? mainPhotoUrls[currentPhoto.filename] 
        : mainImageUrl;
      
      await new Promise((resolve, reject) => {
        mainImg.onload = resolve;
        mainImg.onerror = reject;
        mainImg.src = cachedPhotoUrl;
      });
      
      
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
      
      // Загружаем и рисуем все тайлы (используем кэш)
      const tilePromises = tiles.map(async (tile, _index) => {
        const tileImg = new Image();
        tileImg.crossOrigin = 'anonymous';
        
        return new Promise((resolve) => {
          // Используем прямой URL - браузер сам закэширует изображение
          const tileUrl = `/photos/${images[tile.imageIndex]?.filename}`;
          tileImg.src = tileUrl;
          
          tileImg.onload = () => {
            resolve({ tile, tileImg });
          };
          tileImg.onerror = () => resolve(null); // Пропускаем ошибки загрузки
        });
      });
      
      // Ждем загрузки всех тайлов
      const loadedTiles = (await Promise.all(tilePromises)).filter(item => item !== null);
      
      // Рисуем все тайлы на canvas
      loadedTiles.forEach(({ tile, tileImg }) => {
        // Масштабируем координаты и размеры
        const scaledX = tile.x * scaleFactor;
        const scaledY = tile.y * scaleFactor;
        const scaledWidth = tile.width * scaleFactor;
        const scaledHeight = tile.height * scaleFactor;
        
        // Сохраняем состояние контекста
        highResCtx.save();
        
        // Устанавливаем прозрачность
        highResCtx.globalAlpha = 1.0;
        
        // Если тайл имеет форму шестиугольника, используем clip для обрезки
        if (tile.vertices && tile.vertices.length === 6) {
          // Создаем путь для шестиугольника с масштабированными координатами
          highResCtx.beginPath();
          const firstVertex = tile.vertices[0];
          highResCtx.moveTo(
            scaledX + (firstVertex.x - tile.x) * scaleFactor,
            scaledY + (firstVertex.y - tile.y) * scaleFactor
          );
          
          for (let i = 1; i < tile.vertices.length; i++) {
            const vertex = tile.vertices[i];
            highResCtx.lineTo(
              scaledX + (vertex.x - tile.x) * scaleFactor,
              scaledY + (vertex.y - tile.y) * scaleFactor
            );
          }
          
          highResCtx.closePath();
          highResCtx.clip();
        }
        
        // Вычисляем пропорции изображения и контейнера для objectFit: 'cover'
        const imgAspect = tileImg.naturalWidth / tileImg.naturalHeight;
        const containerAspect = scaledWidth / scaledHeight;
        
        let drawWidth, drawHeight, drawX, drawY;
        
        if (imgAspect > containerAspect) {
          // Изображение шире контейнера - подгоняем по высоте
          drawHeight = scaledHeight;
          drawWidth = drawHeight * imgAspect;
          drawX = scaledX - (drawWidth - scaledWidth) / 2;
          drawY = scaledY;
        } else {
          // Изображение выше контейнера - подгоняем по ширине
          drawWidth = scaledWidth;
          drawHeight = drawWidth / imgAspect;
          drawX = scaledX;
          drawY = scaledY - (drawHeight - scaledHeight) / 2;
        }
        
        // Рисуем изображение тайла с сохранением пропорций (objectFit: 'cover')
        highResCtx.drawImage(tileImg, drawX, drawY, drawWidth, drawHeight);
        
        // Восстанавливаем состояние контекста (сбрасывает clip и globalAlpha)
        highResCtx.restore();
      });
      
      // Рисуем главное фото (PNG) поверх мозаики
      // PNG уже готов как есть, просто рисуем его поверх тайлов
      highResCtx.drawImage(mainImg, mainImgX, mainImgY, mainImgWidth, mainImgHeight);
      
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
  }, [tiles, mainImageUrl, containerSize, images, slideshowPhotos, currentMainIndex, isGeneratingHighRes, mainPhotoUrls, mainImageSize]);

  // Ручной выбор основного фото
  const handleIndicatorClick = (index) => {
    if (index === currentMainIndex) return;

    setTimeout(() => {
      setCurrentMainIndex(index);
      
      // Обновляем URL с параметром photo (имя файла без расширения)
      const params = new URLSearchParams(window.location.search);
      const currentPhoto = slideshowPhotos[index];
      if (currentPhoto) {
        const baseName = currentPhoto.filename.replace(/\.(jpg|jpeg|png|heic)$/i, '');
        params.set('photo', baseName);
        window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
      }
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
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', maxWidth: '100vw', padding: '10px 20px 0 20px', position: 'relative', zIndex: 10 }}>
        <h1 className="title" style={{ margin: 0, textAlign: 'center', width: '100%' }}>{config.title}</h1>
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
            position: 'relative'
          }}
        >
        <div 
          className="mosaic-tiles"
          style={{
            '--tile-hover-scale': TILE_HOVER_SCALE,
            width: containerSize.width,
            height: containerSize.height,
            overflow: hoveredTileIndex !== null ? 'visible' : 'visible', // Разрешаем видимость для нижнего ряда
            overflowY: 'visible', // Разрешаем видимость по вертикали
          }}
          onClick={(e) => {
            // Сбрасываем активный тайл при клике вне тайла (только для мобильных)
            if (e.target === e.currentTarget && hoveredTileIndex !== null) {
              setHoveredTileIndex(null);
            }
          }}
          onMouseMove={(e) => {
            if (!debugMode) return;
            
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            // Проверяем, находится ли точка в области основного изображения
            const isInMainImage = x >= mainImageSize.x && 
                                 x <= mainImageSize.x + mainImageSize.width &&
                                 y >= mainImageSize.y && 
                                 y <= mainImageSize.y + mainImageSize.height;
            
            if (!isInMainImage) return;
            
            // Проверяем, есть ли тайл в этой точке (для шестиугольников)
            const tileAtPoint = tiles.find(tile => {
              // Сначала проверяем описанный прямоугольник
              if (x < tile.x || x > tile.x + tile.width ||
                  y < tile.y || y > tile.y + tile.height) {
                return false;
              }
              
              // Если есть информация о шестиугольнике, проверяем точное попадание
              if (tile.centerX !== undefined && tile.centerY !== undefined && tile.hexSide !== undefined) {
                return isPointInHexagon(x, y, tile.centerX, tile.centerY, tile.hexSide);
              }
              
              // Для старых тайлов (без информации о шестиугольнике) используем прямоугольную проверку
              return true;
            });
            
            if (!tileAtPoint) {
              // Нашли пропуск! Логируем информацию
              const relativeX = x - mainImageSize.x;
              const relativeY = y - mainImageSize.y;
              
              // Находим ближайшие тайлы
              const nearbyTiles = tiles
                .filter(tile => {
                  const tileCenterX = tile.x + tile.width / 2;
                  const tileCenterY = tile.y + tile.height / 2;
                  const distance = Math.sqrt(
                    Math.pow(tileCenterX - x, 2) + 
                    Math.pow(tileCenterY - y, 2)
                  );
                  return distance < 100; // В радиусе 100px
                })
                .map(tile => {
                  const tileCenterX = tile.x + tile.width / 2;
                  const tileCenterY = tile.y + tile.height / 2;
                  const distance = Math.sqrt(
                    Math.pow(tileCenterX - x, 2) + 
                    Math.pow(tileCenterY - y, 2)
                  );
                  return {
                    index: tiles.indexOf(tile),
                    x: Math.round(tile.x * 100) / 100,
                    y: Math.round(tile.y * 100) / 100,
                    width: Math.round(tile.width * 100) / 100,
                    height: Math.round(tile.height * 100) / 100,
                    right: Math.round((tile.x + tile.width) * 100) / 100,
                    bottom: Math.round((tile.y + tile.height) * 100) / 100,
                    distance: Math.round(distance * 100) / 100
                  };
                })
                .sort((a, b) => a.distance - b.distance)
                .slice(0, 5); // Топ-5 ближайших тайлов
              
              console.log('[DEBUG] Пропуск тайла обнаружен:', {
                absoluteCoords: { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 },
                relativeToMainImage: { 
                  x: Math.round(relativeX * 100) / 100, 
                  y: Math.round(relativeY * 100) / 100 
                },
                mainImageBounds: {
                  x: mainImageSize.x,
                  y: mainImageSize.y,
                  width: mainImageSize.width,
                  height: mainImageSize.height,
                  right: mainImageSize.x + mainImageSize.width,
                  bottom: mainImageSize.y + mainImageSize.height
                },
                nearbyTiles: nearbyTiles.length > 0 ? nearbyTiles : 'Нет ближайших тайлов',
                totalTiles: tiles.length,
                mainImageTilesCount: tiles.filter(t => 
                  t.x >= mainImageSize.x && 
                  t.x + t.width <= mainImageSize.x + mainImageSize.width &&
                  t.y >= mainImageSize.y && 
                  t.y + t.height <= mainImageSize.y + mainImageSize.height
                ).length
              });
            }
          }}
        >
          {mainImageUrl && mainImageSize.width > 0 && (
            <img
              src={mainImageUrl}
              alt="Main photo"
              className="main-photo"
            />
          )}
          {(() => {
            // Собираем статистику о пропущенных тайлах
            const skippedTiles = [];
            const renderedTiles = [];
            
            const tilesToRender = tiles.map((tile, index) => {
              // Пропускаем тайлы, для которых нет загруженного URL
              const tileUrl = tileImageUrls[tile.imageIndex];
              if (!tileUrl) {
                skippedTiles.push({
                  tileIndex: index,
                  imageIndex: tile.imageIndex,
                  filename: images[tile.imageIndex]?.filename,
                  position: { x: tile.x, y: tile.y, width: tile.width, height: tile.height }
                });
                console.warn(`[DEBUG] Пропуск рендеринга тайла ${index} - нет URL для imageIndex ${tile.imageIndex} (${images[tile.imageIndex]?.filename})`);
                return null;
              }
              
              renderedTiles.push({
                tileIndex: index,
                imageIndex: tile.imageIndex,
                filename: images[tile.imageIndex]?.filename
              });
              
              return { tile, index, tileUrl };
            }).filter(item => item !== null);
            
            // Логируем статистику только если есть пропущенные тайлы
            if (skippedTiles.length > 0) {
              console.error('[DEBUG] Статистика рендеринга тайлов:', {
                totalTiles: tiles.length,
                renderedTiles: renderedTiles.length,
                skippedTiles: skippedTiles.length,
                skippedTilesDetails: skippedTiles
              });
            }
            
            return tilesToRender.map(({ tile, index, tileUrl }) => {
            
            const isActive = hoveredTileIndex === index;
            const tileKey = `${currentMainIndex}-${index}`;
            
            // Вычисляем clip-path для шестиугольника
            const clipPath = tile.vertices 
              ? getHexagonClipPath(tile.vertices.map(v => ({
                  x: v.x - tile.x,
                  y: v.y - tile.y
                })))
              : 'none';
            
            return (
              <div
                key={tileKey}
                className={`mosaic-tile ${isActive ? 'active' : ''}`}
                style={{
                  left: tile.x,
                  top: tile.y,
                  width: tile.width,
                  height: tile.height,
                  clipPath: clipPath,
                  WebkitClipPath: clipPath, // Для Safari
                  overflow: 'visible', // Разрешаем видимость за пределами контейнера
                  // Скрываем обычный тайл при hover, так как увеличенный отображается в отдельном слое
                  opacity: isActive ? 0 : 1,
                  transition: 'opacity 0.3s ease',
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
                  src={tileUrl}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    // Если изображение не загрузилось, скрываем его
                    if (debugMode) {
                      console.warn(`[DEBUG] Ошибка загрузки изображения тайла ${index}:`, tileUrl);
                    }
                    e.target.style.display = 'none';
                  }}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    ...(debugMode && {
                      border: '1px solid rgba(255, 255, 255, 0.3)', // Белая рамка для визуализации
                      boxSizing: 'border-box'
                    })
                  }}
                />
              </div>
            );
            });
          })()}
        </div>
        
        {/* Отдельный слой для активного тайла без маски */}
        {hoveredTileIndex !== null && tiles[hoveredTileIndex] && (() => {
          const activeTile = tiles[hoveredTileIndex];
          const activeTileUrl = tileImageUrls[activeTile.imageIndex];
          if (!activeTileUrl) return null;
          
          const activeClipPath = activeTile.vertices 
            ? getHexagonClipPath(activeTile.vertices.map(v => ({
                x: v.x - activeTile.x,
                y: v.y - activeTile.y
              })))
            : 'none';
          
          return (
            <div
              className="mosaic-tile-active-layer"
              style={{
                position: 'absolute',
                left: activeTile.x,
                top: activeTile.y,
                width: activeTile.width,
                height: activeTile.height,
                clipPath: activeClipPath,
                WebkitClipPath: activeClipPath,
                zIndex: 1000, // Высокий z-index чтобы быть поверх всех тайлов
                transform: `scale(${TILE_HOVER_SCALE})`,
                transformOrigin: 'center center',
                pointerEvents: 'none', // Не блокируем события мыши
              }}
            >
              <img
                src={activeTileUrl}
                alt=""
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  boxShadow: '0 5px 20px rgba(0, 0, 0, 0.5)',
                }}
              />
            </div>
          );
        })()}

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
