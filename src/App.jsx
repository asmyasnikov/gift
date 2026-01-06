import { useState, useEffect, useRef, useCallback } from 'react';
import imageCache from './imageCache';
import { config } from '@/config.js';

// Порог вариации цвета для дробления области
const VARIANCE_THRESHOLD = 800;
// Максимальный размер канваса для анализа (по большей стороне)
const MAX_CANVAS_SIZE = 512;

// Константы для opacity тайлов
const MIN_OPACITY = 0.1; // Минимальная прозрачность в центре (лицо/центр кадра)
const MAX_OPACITY = 1.0;  // Максимальная прозрачность на краях

// Константа для градиента opacity за пределами маски
// Определяет количество тайлов от границы прозрачной области маски, на котором происходит переход от MIN_OPACITY к MAX_OPACITY
// Значение = количество тайлов (1, 2, 3, ...)
// Больше значение = более плавный/длинный переход (больше тайлов в переходе), меньше = более резкий/короткий переход
const OPACITY_TRANSITION_TILES = 1; // Количество тайлов для перехода от min к max opacity

// Константы для фильтров изображений
const IMAGE_BRIGHTNESS = 0.85; // Яркость тайлов (0.0 - темнее, 1.0 - оригинал, >1.0 - ярче)
const IMAGE_SATURATE = 1.15;   // Насыщенность тайлов (0.0 - ч/б, 1.0 - оригинал, >1.0 - ярче)

// Константа для увеличения тайла при наведении/клике
const TILE_HOVER_SCALE = 5; // Масштаб увеличения тайла (1.0 = без увеличения, 2.0 = в 2 раза, и т.д.)

// Константа для максимального количества использований одного тайла
const MAX_TILE_USAGE = 2; // Максимальное количество раз, которое один тайл может быть использован

// Константы для шестиугольной сетки (пчелиных сот)
// Множитель для расстояния между центрами по горизонтали: sqrt(3) для правильной упаковки
const HEXAGON_HORIZONTAL_SPACING_MULTIPLIER = Math.sqrt(3)+0.05;
// Множитель для расстояния между рядами по вертикали: 1.5 для правильной упаковки
const HEXAGON_VERTICAL_SPACING_MULTIPLIER = 1.55;

// Константа для ширины градиента прозрачности на границах главного фото
// Значение в множителях диаметра описанной окружности соты (1.0 = 1 сота, 1.5 = 1.5 соты, 2.0 = 2 соты)
const BORDER_GRADIENT_WIDTH_MULTIPLIER = 1.5;

// Загрузка маски для фото
// Маска - это PNG файл с альфа-каналом, где прозрачные области = области с min opacity
async function loadMask(maskFilename, canvasWidth, canvasHeight, containerSize, maskUrl = null) {
  try {
    const maskImg = new Image();
    maskImg.crossOrigin = 'anonymous';
    
    // Используем переданный URL или формируем стандартный
    const url = maskUrl || `/photos/${maskFilename}`;
    
    await new Promise((resolve, reject) => {
      maskImg.onload = resolve;
      maskImg.onerror = reject;
      maskImg.src = url;
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
function buildQuadtree(imageData, canvasWidth, canvasHeight, minTileSize = null, maxTileSize = null) {
  // Если не указаны размеры, используем разумные значения по умолчанию
  let defaultMinTileSize = minTileSize || Math.min(canvasWidth, canvasHeight) / 30;
  let defaultMaxTileSize = maxTileSize || Math.min(canvasWidth, canvasHeight) / 10;
  
  // Убеждаемся, что размеры валидны
  const absoluteMinSize = 2; // Абсолютный минимум размера узла
  const absoluteMaxSize = Math.max(canvasWidth, canvasHeight);
  
  defaultMinTileSize = Math.max(defaultMinTileSize, absoluteMinSize);
  defaultMaxTileSize = Math.min(defaultMaxTileSize, absoluteMaxSize);
  
  // Убеждаемся, что min < max
  if (defaultMinTileSize >= defaultMaxTileSize) {
    defaultMaxTileSize = defaultMinTileSize * 2;
  }
  
  // Используем размер, который гарантированно покрывает весь canvas
  // Округляем до ближайшей степени двойки для правильного деления
  const rootSize = Math.pow(2, Math.ceil(Math.log2(Math.max(canvasWidth, canvasHeight))));
  const root = new QuadNode(0, 0, rootSize);
  const queue = [root];
  
  // Ограничение глубины для предотвращения бесконечных циклов
  const maxDepth = 20;
  let iterations = 0;
  const maxIterations = 10000; // Максимальное количество итераций

  while (queue.length > 0 && iterations < maxIterations) {
    iterations++;
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
    
    // Проверяем глубину - не дробим слишком глубоко
    if (node.depth >= maxDepth) {
      // Достигли максимальной глубины - делаем листовым узлом
      node.avgColor = getAreaColor(imageData, node.x, node.y, actualSize, canvasWidth);
      node.size = actualSize;
      continue;
    }

    // Проверяем нужно ли дробить
    if (actualSize > defaultMinTileSize) {
      const variance = calculateVariance(imageData, node.x, node.y, actualSize, canvasWidth);
      
      // Дробим если:
      // 1. Высокая вариация и размер больше минимума
      // 2. Размер больше максимума (слишком большой тайл)
      const shouldSplit = 
        (variance > VARIANCE_THRESHOLD && actualSize > defaultMinTileSize) ||
        (actualSize > defaultMaxTileSize);

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
  
  if (iterations >= maxIterations) {
    console.warn('[WARNING] buildQuadtree достиг максимального количества итераций');
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

// Структура для представления области размещения тайла
class TilePlacement {
  constructor(x, y, width, height, avgColor, variance, priority = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.avgColor = avgColor;
    this.variance = variance;
    this.priority = priority; // Приоритет размещения (выше = размещается раньше)
    this.placed = false;
  }
  
  getCenterX() {
    return this.x + this.width / 2;
  }
  
  getCenterY() {
    return this.y + this.height / 2;
  }
  
  getArea() {
    return this.width * this.height;
  }
  
  // Вычисляет расстояние от центра до заданной точки
  distanceToCenter(centerX, centerY) {
    const cx = this.getCenterX();
    const cy = this.getCenterY();
    return Math.sqrt(Math.pow(cx - centerX, 2) + Math.pow(cy - centerY, 2));
  }
}

// Проверяет, пересекаются ли два прямоугольника
function rectanglesIntersect(rect1, rect2) {
  return !(rect1.x + rect1.width <= rect2.x ||
           rect2.x + rect2.width <= rect1.x ||
           rect1.y + rect1.height <= rect2.y ||
           rect2.y + rect2.height <= rect1.y);
}

// Проверяет, пересекается ли прямоугольник с любым из размещенных тайлов
function hasCollision(tileRect, placedTiles, minGap = 0) {
  const expandedRect = {
    x: tileRect.x - minGap,
    y: tileRect.y - minGap,
    width: tileRect.width + minGap * 2,
    height: tileRect.height + minGap * 2
  };
  
  for (const placedTile of placedTiles) {
    const placedRect = {
      x: placedTile.x,
      y: placedTile.y,
      width: placedTile.width,
      height: placedTile.height
    };
    
    if (rectanglesIntersect(expandedRect, placedRect)) {
      return true;
    }
  }
  
  return false;
}

// Находит оптимальную позицию для тайла с учетом столкновений
// Использует спиральный поиск от целевой позиции
function findOptimalPosition(targetX, targetY, tileWidth, tileHeight, placedTiles, bounds, maxAttempts = 50) {
  const minGap = 1; // Минимальный зазор между тайлами в пикселях
  
  // Проверяем целевую позицию
  const targetRect = {
    x: targetX,
    y: targetY,
    width: tileWidth,
    height: tileHeight
  };
  
  // Убеждаемся, что тайл в пределах границ
  if (targetRect.x >= bounds.minX && 
      targetRect.y >= bounds.minY &&
      targetRect.x + targetRect.width <= bounds.maxX &&
      targetRect.y + targetRect.height <= bounds.maxY) {
    if (!hasCollision(targetRect, placedTiles, minGap)) {
      return { x: targetX, y: targetY, found: true };
    }
  }
  
  // Спиральный поиск от целевой позиции
  const stepSize = Math.max(tileWidth, tileHeight) * 0.1;
  let radius = stepSize;
  let angle = 0;
  const angleStep = Math.PI / 8; // 8 попыток на круг
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const offsetX = Math.cos(angle) * radius;
    const offsetY = Math.sin(angle) * radius;
    
    const testX = targetX + offsetX;
    const testY = targetY + offsetY;
    
    const testRect = {
      x: testX,
      y: testY,
      width: tileWidth,
      height: tileHeight
    };
    
    // Проверяем границы
    if (testRect.x >= bounds.minX && 
        testRect.y >= bounds.minY &&
        testRect.x + testRect.width <= bounds.maxX &&
        testRect.y + testRect.height <= bounds.maxY) {
      // Проверяем столкновения
      if (!hasCollision(testRect, placedTiles, minGap)) {
        return { x: testX, y: testY, found: true };
      }
    }
    
    angle += angleStep;
    if (angle >= Math.PI * 2) {
      angle = 0;
      radius += stepSize;
    }
  }
  
  // Если не нашли позицию, возвращаем целевую (будет наложение, но лучше чем ничего)
  return { x: targetX, y: targetY, found: false };
}

// Оптимизирует размер тайла, чтобы он лучше заполнял доступное пространство
function optimizeTileSize(targetSize, areaWidth, areaHeight, photoAspect, minTileSize, maxTileSize) {
  let tileWidth, tileHeight;
  
  // Вычисляем размеры с точными пропорциями фото
  if (photoAspect > areaWidth / areaHeight) {
    // Фото шире области - подгоняем по ширине
    tileWidth = Math.min(targetSize, areaWidth);
    tileHeight = tileWidth / photoAspect;
    
    // Если высота превышает доступное пространство, подгоняем по высоте
    if (tileHeight > areaHeight) {
      tileHeight = areaHeight;
      tileWidth = tileHeight * photoAspect;
    }
  } else {
    // Фото уже области - подгоняем по высоте
    tileHeight = Math.min(targetSize, areaHeight);
    tileWidth = tileHeight * photoAspect;
    
    // Если ширина превышает доступное пространство, подгоняем по ширине
    if (tileWidth > areaWidth) {
      tileWidth = areaWidth;
      tileHeight = tileWidth / photoAspect;
    }
  }
  
  // Ограничиваем минимальным и максимальным размером
  const currentSize = Math.sqrt(tileWidth * tileHeight);
  if (currentSize < minTileSize) {
    const scale = minTileSize / currentSize;
    tileWidth *= scale;
    tileHeight *= scale;
  } else if (currentSize > maxTileSize) {
    const scale = maxTileSize / currentSize;
    tileWidth *= scale;
    tileHeight *= scale;
  }
  
  return { width: tileWidth, height: tileHeight };
}

// Создает области для размещения тайлов на основе анализа изображения
function createPlacementAreas(imageAreaData, imageAreaWidth, imageAreaHeight, mainImgX, mainImgY, mainImgWidth, mainImgHeight, scaleX, scaleY, quadtreeRoot = null) {
  const areas = [];
  
  // Используем переданный Quadtree или строим новый
  const root = quadtreeRoot || buildQuadtree(imageAreaData, imageAreaWidth, imageAreaHeight);
  const leaves = collectLeaves(root).filter(node => {
    if (!node.avgColor) return false;
    const c = node.avgColor;
    if (!isFinite(c.r) || !isFinite(c.g) || !isFinite(c.b) ||
        isNaN(c.r) || isNaN(c.g) || isNaN(c.b)) {
      return false;
    }
    if (node.x < 0 || node.y < 0 || 
        node.x >= imageAreaWidth || node.y >= imageAreaHeight) {
      return false;
    }
    return true;
  });
  
  // Преобразуем узлы Quadtree в области размещения
  leaves.forEach(node => {
    // Масштабируем координаты и размеры от области изображения к размеру главного фото в контейнере
    const x = mainImgX + node.x * scaleX;
    const y = mainImgY + node.y * scaleY;
    const width = node.size * scaleX;
    const height = node.size * scaleY;
    
    // Вычисляем вариацию для определения размера тайла
    const variance = calculateVariance(imageAreaData, node.x, node.y, node.size, imageAreaWidth);
    
    // Определяем приоритет: сначала центр, затем по близости к центру
    const nodeCenterX = node.x + node.size / 2;
    const nodeCenterY = node.y + node.size / 2;
    const imageAreaCenterX = imageAreaWidth / 2;
    const imageAreaCenterY = imageAreaHeight / 2;
    const distanceFromCenter = Math.sqrt(
      Math.pow(nodeCenterX - imageAreaCenterX, 2) + 
      Math.pow(nodeCenterY - imageAreaCenterY, 2)
    );
    const maxDistance = Math.sqrt(imageAreaWidth * imageAreaWidth + imageAreaHeight * imageAreaHeight) / 2;
    const normalizedDistance = distanceFromCenter / maxDistance;
    
    // Приоритет: выше для центральных областей и однородных (низкая вариация)
    // Центральные области размещаются первыми, затем по удалению от центра
    // Однородные области (низкая вариация) получают больший приоритет
    const varianceFactor = variance < VARIANCE_THRESHOLD ? 1.0 : 0.5; // Однородные области важнее
    const priority = (1.0 - normalizedDistance) * varianceFactor;
    
    areas.push(new TilePlacement(
      x, y, width, height,
      node.avgColor,
      variance,
      priority
    ));
  });
  
  // Сортируем по приоритету (высокий приоритет = размещается раньше)
  areas.sort((a, b) => b.priority - a.priority);
  
  return areas;
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
  const [borderGradientWidth, setBorderGradientWidth] = useState(0); // Ширина градиента для границ главного фото
  const [autoPlay, setAutoPlay] = useState(false);
  const [maskData, setMaskData] = useState(null);
  const [debugMode, setDebugMode] = useState(false);
  const [isGeneratingHighRes, setIsGeneratingHighRes] = useState(false);
  const [hoveredTileIndex, setHoveredTileIndex] = useState(null);
  const [tileImageUrls, setTileImageUrls] = useState({}); // Кэш URL'ов тайлов (объект для React state)
  const [mainPhotoUrls, setMainPhotoUrls] = useState({}); // Кэш URL'ов главных фото
  const [maskUrls, setMaskUrls] = useState({}); // Кэш URL'ов масок
  const [availableTileIndices, setAvailableTileIndices] = useState(new Set()); // Индексы фото, для которых есть тайлы
  const [tilesLoaded, setTilesLoaded] = useState(false); // Флаг, что все тайлы загружены и проверены

  const canvasRef = useRef(null);
  const ctxRef = useRef(null);

  // Очищаем кэш при загрузке страницы для отображения свежих изменений
  useEffect(() => {
    const clearCache = async () => {
      try {
        await imageCache.clear();
        console.log('[DEBUG] Кэш очищен при загрузке страницы');
      } catch (error) {
        console.warn('[DEBUG] Ошибка очистки кэша:', error);
      }
    };
    clearCache();
  }, []); // Выполняется только один раз при монтировании компонента

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

  // Предзагружаем все главные фото и маски через кэш
  useEffect(() => {
    if (slideshowPhotos.length === 0) return;

    const preloadMainPhotos = async () => {
      const newMainPhotoUrls = {};
      const newMaskUrls = {};
      
      if (debugMode) {
        console.log('[DEBUG] Начинаем предзагрузку главных фото и масок:', {
          count: slideshowPhotos.length
        });
      }

      // Загружаем все главные фото и маски параллельно
      const loadPromises = slideshowPhotos.map(async (photo) => {
        const photoUrl = `/photos/${photo.filename}`;
        const baseName = photo.filename.replace(/\.(jpg|jpeg)$/i, '');
        const maskFilename = `${baseName}.png`;
        const maskUrl = `/photos/${maskFilename}`;
        
        try {
          // Загружаем главное фото через кэш
          const cachedPhotoUrl = await imageCache.loadImage(photoUrl);
          if (cachedPhotoUrl) {
            newMainPhotoUrls[photo.filename] = cachedPhotoUrl;
          }
          
          // Загружаем маску через кэш
          try {
            const cachedMaskUrl = await imageCache.loadImage(maskUrl);
            if (cachedMaskUrl) {
              newMaskUrls[photo.filename] = cachedMaskUrl;
            }
          } catch (maskError) {
            // Маска может отсутствовать, это нормально
            if (debugMode) {
              console.log('[DEBUG] Маска не загружена в кэш:', maskUrl, maskError);
            }
          }
        } catch (error) {
          console.warn('Ошибка предзагрузки главного фото:', photoUrl, error);
          // Fallback на прямой URL
          newMainPhotoUrls[photo.filename] = photoUrl;
        }
      });
      
      await Promise.all(loadPromises);
      setMainPhotoUrls(newMainPhotoUrls);
      setMaskUrls(newMaskUrls);
      
      if (debugMode) {
        console.log('[DEBUG] Предзагрузка главных фото и масок завершена:', {
          photosLoaded: Object.keys(newMainPhotoUrls).length,
          masksLoaded: Object.keys(newMaskUrls).length,
          totalPhotos: slideshowPhotos.length
        });
      }
    };

    preloadMainPhotos();
  }, [slideshowPhotos, debugMode]);

  // Загружаем изображения после получения индекса и предзагружаем все тайлы
  useEffect(() => {
    if (!photoIndex) return;

    const loadImages = async () => {
      // Сбрасываем флаг загрузки тайлов при новой загрузке
      setTilesLoaded(false);
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

      setImages(loadedImages);
      setPhotoColors(colors);
      setPhotoAspects(photoAspects);
      
      // Предзагружаем все тайлы из /tiles/ (все файлы из index.json)
      // Главные фото могут быть тайлами - для них есть уменьшенные версии в /tiles/
      setLoadingProgress('Предзагрузка тайлов...');
      
      // Предзагружаем все тайлы из /tiles/ и проверяем их существование
      // Создаем Set доступных индексов тайлов
      const availableIndices = new Set();
      const missingTiles = [];
      const tilePromises = photos.map(async (photo, index) => {
        const tileUrl = `/tiles/${photo.filename}`;
        const cachedUrl = await imageCache.loadImage(tileUrl); // loadImage возвращает null если файл не найден
        if (cachedUrl) {
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
      });
      
      // Ждем завершения загрузки всех тайлов
      await Promise.all(tilePromises);
      
      // Сохраняем список доступных индексов тайлов
      setAvailableTileIndices(availableIndices);
      
      // Устанавливаем флаг, что все тайлы загружены и проверены
      setTilesLoaded(true);
      
      console.log('[DEBUG] Все тайлы предзагружены и проверены', {
        totalPhotos: photos.length,
        tilesPreloaded: tilePromises.length,
        availableTiles: availableIndices.size,
        missingTiles: photos.length - availableIndices.size,
        availableIndices: Array.from(availableIndices).sort((a, b) => a - b),
        missingTilesList: missingTiles.map(t => `${t.index}:${t.filename}`)
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
  }, [photoIndex, debugMode]);

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
      if (debugMode) {
        console.log('[DEBUG] generateMosaic пропущен:', {
          imagesLength: images.length,
          slideshowPhotosLength: slideshowPhotos.length,
          containerWidth: containerSize.width,
          tilesLoaded,
          availableTilesCount: availableTileIndices.size
        });
      }
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
    
    // Загружаем основное фото через кэш (оригинальное, не сжатое)
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
    setImageAspectRatio(imgAspect);
    
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

    // Строим Quadtree только для области, где нарисовано изображение
    // Это важно, чтобы тайлы покрывали всю область основного изображения
    const imageAreaWidth = drawWidth;
    const imageAreaHeight = drawHeight;
    const imageAreaX = drawX;
    const imageAreaY = drawY;
    
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

    // Исключаем только текущее главное фото из списка доступных для тайлов
    // Главные фото могут быть тайлами (у них есть уменьшенные версии в /tiles/)
    // Но не используем текущее главное фото как тайл на самом себе
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
      console.error('[ERROR] Нет доступных тайлов');
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
    mainImgWidth = Math.max(0, originalMainImgWidth - a);
    mainImgHeight = Math.max(0, originalMainImgHeight - a);
    mainImgX = (containerSize.width - mainImgWidth) / 2;
    mainImgY = (containerSize.height - mainImgHeight) / 2;
    
    // Обновляем размер главного фото в состоянии
    setMainImageSize({ width: mainImgWidth, height: mainImgHeight, x: mainImgX, y: mainImgY });
    
    // Загружаем маску после уменьшения главного фото на `a`
    // Маска имеет то же имя что и фото, но с расширением PNG
    // Масштабируем маску до размера уменьшенного главного фото
    const baseName = currentPhoto.filename.replace(/\.(jpg|jpeg)$/i, '');
    const maskFilename = `${baseName}.png`;
    let currentMaskData = null;
    try {
      // Используем уменьшенные размеры главного фото для маски
      const maskSize = { width: mainImgWidth, height: mainImgHeight };
      // Используем кэшированный URL маски если доступен
      const maskUrl = `/photos/${maskFilename}`;
      const cachedMaskUrl = maskUrls[currentPhoto.filename] || maskUrl;
      const mask = await loadMask(maskFilename, canvasWidth, canvasHeight, maskSize, cachedMaskUrl);
      if (mask && mask.imageData) {
        currentMaskData = mask;
        if (debugMode) {
          console.log('[DEBUG] Маска загружена:', {
            filename: maskFilename,
            width: mask.width,
            height: mask.height,
            fromCache: !!maskUrls[currentPhoto.filename]
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
    
    // Вычисляем средний размер тайла для градиента opacity
    const averageTileSize = d_описанная;
    
    // Ширина градиента для границ главного фото
    const borderGradientWidthValue = d_описанная * BORDER_GRADIENT_WIDTH_MULTIPLIER;
    // Сохраняем ширину градиента для использования в CSS mask главного фото
    setBorderGradientWidth(borderGradientWidthValue);
    
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
        
        // Вычисляем opacity на основе маски (только если попадает на главное фото)
        let opacity = MAX_OPACITY; // По умолчанию максимальная прозрачность
        if (isOnMainImage) {
          // Координаты центра относительно главного фото для маски
          const maskX = centerX - mainImgX;
          const maskY = centerY - mainImgY;
          opacity = calculateTileOpacity(
            maskX,
            maskY,
            mainImgWidth,
            mainImgHeight,
            currentMaskData,
            averageTileSize
          );
          
          // Применяем градиент прозрачности на границах главного фото
          // Вычисляем расстояние от центра соты до ближайшей границы главного фото
          const distToLeft = maskX;
          const distToRight = mainImgWidth - maskX;
          const distToTop = maskY;
          const distToBottom = mainImgHeight - maskY;
          
          // Находим минимальное расстояние до границы
          const minDistToBorder = Math.min(distToLeft, distToRight, distToTop, distToBottom);
          
          // Если сота находится в зоне градиента (ближе к краю, чем ширина градиента)
          if (minDistToBorder < borderGradientWidthValue) {
            // Вычисляем коэффициент прозрачности: от 0 (на краю) до 1 (на расстоянии borderGradientWidthValue)
            const borderOpacityFactor = minDistToBorder / borderGradientWidthValue;
            // Применяем градиент: на краю opacity минимальная (MIN_OPACITY), на расстоянии borderGradientWidth - исходная opacity
            const borderOpacity = opacity * borderOpacityFactor;
            opacity = borderOpacity;
          }
        }
        
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
          opacity,
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
    
    // Обновляем маску в состоянии только один раз после генерации
    setMaskData(currentMaskData);
    
    setTiles(newTiles);
  }, [images, photoColors, photoAspects, slideshowPhotos, currentMainIndex, containerSize, debugMode, mainPhotoUrls, maskUrls, availableTileIndices, tilesLoaded]);

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
        
        const tileUrl = `/tiles/${image.filename}`;
        
        // loadImage возвращает null если файл не найден
        const cachedUrl = await imageCache.loadImage(tileUrl);
        if (cachedUrl) {
          newUrls[imageIndex] = cachedUrl;
          loadedIndices.push(imageIndex);
          if (debugMode) {
            console.log(`[DEBUG] Тайл загружен: index=${imageIndex}, filename=${image.filename}`);
          }
        } else {
          // Если тайл не загрузился, не добавляем его (не используем fallback)
          failedIndices.push({ index: imageIndex, filename: image.filename, url: tileUrl });
          console.warn(`[DEBUG] Тайл не загружен: ${tileUrl} (imageIndex: ${imageIndex}, filename: ${image.filename})`);
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
      
      // Загружаем основное фото в высоком разрешении (используем кэш)
      const mainImg = new Image();
      mainImg.crossOrigin = 'anonymous';
      
      // Используем кэшированный URL если доступен
      const currentPhoto = slideshowPhotos[currentMainIndex];
      const photoUrl = currentPhoto ? `/photos/${currentPhoto.filename}` : mainImageUrl;
      const cachedPhotoUrl = currentPhoto && mainPhotoUrls[currentPhoto.filename] 
        ? mainPhotoUrls[currentPhoto.filename] 
        : mainImageUrl;
      
      await new Promise((resolve, reject) => {
        mainImg.onload = resolve;
        mainImg.onerror = reject;
        mainImg.src = cachedPhotoUrl;
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
      
      // Загружаем и рисуем все тайлы (используем кэш)
      const tilePromises = tiles.map(async (tile, index) => {
        const tileImg = new Image();
        tileImg.crossOrigin = 'anonymous';
        
        return new Promise(async (resolve) => {
          // Используем кэш для загрузки тайла
          // loadImage теперь возвращает null вместо выброса ошибки
          const tileUrl = `/tiles/${images[tile.imageIndex]?.filename}`;
          const cachedUrl = await imageCache.loadImage(tileUrl);
          tileImg.src = cachedUrl || tileUrl;
          
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
  }, [tiles, mainImageUrl, containerSize, images, slideshowPhotos, currentMainIndex, debugMode, isGeneratingHighRes, MIN_OPACITY, IMAGE_BRIGHTNESS, IMAGE_SATURATE, mainPhotoUrls]);

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
              zIndex: 1,
              // Добавляем градиент прозрачности на границах главного фото
              // Используем четыре градиента для каждой стороны и объединяем их
              ...(borderGradientWidth > 0 ? {
                maskImage: `
                  linear-gradient(to right, 
                    transparent 0%, 
                    black ${borderGradientWidth}px, 
                    black calc(100% - ${borderGradientWidth}px), 
                    transparent 100%),
                  linear-gradient(to bottom, 
                    transparent 0%, 
                    black ${borderGradientWidth}px, 
                    black calc(100% - ${borderGradientWidth}px), 
                    transparent 100%)
                `,
                maskComposite: 'intersect',
                WebkitMaskImage: `
                  linear-gradient(to right, 
                    transparent 0%, 
                    black ${borderGradientWidth}px, 
                    black calc(100% - ${borderGradientWidth}px), 
                    transparent 100%),
                  linear-gradient(to bottom, 
                    transparent 0%, 
                    black ${borderGradientWidth}px, 
                    black calc(100% - ${borderGradientWidth}px), 
                    transparent 100%)
                `,
                WebkitMaskComposite: 'source-in'
              } : {})
            }}
          />
        )}
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
                    opacity: isActive ? 1 : (tile.opacity || MIN_OPACITY),
                    filter: debugMode 
                      ? 'brightness(0) contrast(1)' // Черные прямоугольники в режиме отладки
                      : `brightness(${IMAGE_BRIGHTNESS}) saturate(${IMAGE_SATURATE})`,
                    transition: 'opacity 0.3s ease',
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
