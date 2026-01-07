import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const PHOTOS_DIR = path.join(process.cwd(), 'photos');
const INDEX_FILE = path.join(PHOTOS_DIR, 'index.json');

// Поддерживаемые форматы изображений
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

// Исключаемые файлы
const EXCLUDED_FILES = ['index.json'];

// Паттерны для исключения из слайд-шоу
const EXCLUDE_PATTERNS = [
];

async function getImageMetadata(filePath) {
  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();
    
    // Получаем средний цвет, уменьшая изображение до 1x1
    const { data } = await image
      .resize(1, 1, { fit: 'cover' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // Получаем статистику для анализа
    const stats = await sharp(filePath).stats();
    
    // Вычисляем яркость
    const brightness = (data[0] * 0.299 + data[1] * 0.587 + data[2] * 0.114) / 255;
    
    // Контраст из стандартного отклонения
    const { channels } = stats;
    const avgStdDev = channels.reduce((sum, ch) => sum + ch.stdev, 0) / channels.length;
    
    return {
      width: metadata.width,
      height: metadata.height,
      avgColor: {
        r: data[0],
        g: data[1],
        b: data[2]
      },
      brightness,
      contrast: avgStdDev / 128,
      aspectRatio: metadata.width / metadata.height
    };
  } catch (error) {
    console.error(`Ошибка обработки ${filePath}:`, error.message);
    return null;
  }
}

function shouldExcludeFromSlideshow(filename) {
  return EXCLUDE_PATTERNS.some(pattern => pattern.test(filename));
}

async function indexPhotos() {
  console.log('🔍 Сканирование папки photos...\n');
  
  // Читаем существующий индекс если есть (для сохранения других полей)
  let existingIndex = {};
  try {
    const existing = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    existing.photos.forEach(p => {
      existingIndex[p.filename] = p;
    });
  } catch (e) {
    // Нет существующего индекса
  }
  
  const files = fs.readdirSync(PHOTOS_DIR);
  
  const imageFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    // Включаем все поддерживаемые форматы, включая PNG (PNG файлы - это главные фото)
    return IMAGE_EXTENSIONS.includes(ext) && 
           !EXCLUDED_FILES.includes(file);
  });
  
  console.log(`📷 Найдено ${imageFiles.length} изображений\n`);
  
  const index = {
    generatedAt: new Date().toISOString(),
    totalPhotos: imageFiles.length,
    photos: []
  };
  
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const filePath = path.join(PHOTOS_DIR, file);
    
    if (i % 20 === 0) {
      console.log(`[${i + 1}/${imageFiles.length}] Обработка...`);
    }
    
    const metadata = await getImageMetadata(filePath);
    
    if (metadata) {
      const isExcluded = shouldExcludeFromSlideshow(file);
      
      index.photos.push({
        filename: file,
        width: metadata.width,
        height: metadata.height,
        avgColor: metadata.avgColor,
        brightness: Math.round(metadata.brightness * 100) / 100,
        contrast: Math.round(metadata.contrast * 100) / 100,
        notes: isExcluded ? 'Исключено по паттерну' : ''
      });
    }
  }
  
  // Сортируем по имени файла
  index.photos.sort((a, b) => a.filename.localeCompare(b.filename));
  
  // Сохраняем индекс
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
  
  console.log(`\n✅ Индекс сохранён в ${INDEX_FILE}`);
  console.log(`📊 Всего фото: ${index.photos.length}`);
  console.log(`📊 Главных фото (PNG): ${index.photos.filter(p => p.filename.toLowerCase().endsWith('.png')).length}`);
  console.log(`📊 Тайлов (JPG/JPEG): ${index.photos.filter(p => {
    const ext = p.filename.toLowerCase();
    return ext.endsWith('.jpg') || ext.endsWith('.jpeg');
  }).length}`);
}

indexPhotos().catch(console.error);
