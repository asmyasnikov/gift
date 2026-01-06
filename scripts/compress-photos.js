import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const PHOTOS_DIR = path.join(process.cwd(), 'photos');
const TILES_DIR = path.join(process.cwd(), 'tiles');

// Размер для тайлов (максимальная сторона)
const TILE_MAX_SIZE = 768;
// Качество JPEG для тайлов
const TILE_QUALITY = 85;

// Поддерживаемые форматы
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg'];

// Исключаемые файлы
const EXCLUDED_FILES = ['index.json', 'reference.jpg'];

async function compressPhoto(inputPath, outputPath) {
  try {
    const metadata = await sharp(inputPath).metadata();
    const { width, height } = metadata;
    
    // Вычисляем размеры с сохранением пропорций
    let newWidth, newHeight;
    if (width > height) {
      newWidth = Math.min(width, TILE_MAX_SIZE);
      newHeight = Math.round((height * newWidth) / width);
    } else {
      newHeight = Math.min(height, TILE_MAX_SIZE);
      newWidth = Math.round((width * newHeight) / height);
    }
    
    // Сжимаем изображение с автоматическим поворотом по EXIF (но сохраняем ориентацию)
    // Используем rotate() чтобы применить EXIF ориентацию, но затем нормализуем
    await sharp(inputPath)
      .rotate() // Автоматически поворачивает по EXIF, затем удаляет EXIF ориентацию
      .resize(newWidth, newHeight, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ 
        quality: TILE_QUALITY,
        mozjpeg: true 
      })
      .toFile(outputPath);
    
    const originalSize = fs.statSync(inputPath).size;
    const compressedSize = fs.statSync(outputPath).size;
    const compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
    
    return {
      success: true,
      originalSize,
      compressedSize,
      compressionRatio,
      dimensions: { width: newWidth, height: newHeight }
    };
  } catch (error) {
    console.error(`Ошибка сжатия ${inputPath}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function compressAllPhotos() {
  console.log('🗜️  Сжатие фотографий для тайлов...\n');
  
  // Создаём папку tiles если её нет
  if (!fs.existsSync(TILES_DIR)) {
    fs.mkdirSync(TILES_DIR, { recursive: true });
    console.log('📁 Создана папка tiles/\n');
  }
  
  // Читаем все файлы из photos
  const files = fs.readdirSync(PHOTOS_DIR);
  const imageFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext) && !EXCLUDED_FILES.includes(file);
  });
  
  console.log(`📷 Найдено ${imageFiles.length} изображений\n`);
  
  let successCount = 0;
  let failCount = 0;
  let totalOriginalSize = 0;
  let totalCompressedSize = 0;
  
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const inputPath = path.join(PHOTOS_DIR, file);
    const outputPath = path.join(TILES_DIR, file);
    
    // Пропускаем если уже существует
    if (fs.existsSync(outputPath)) {
      if (i % 20 === 0) {
        console.log(`[${i + 1}/${imageFiles.length}] Пропуск (уже существует): ${file}`);
      }
      continue;
    }
    
    if (i % 10 === 0 || i === imageFiles.length - 1) {
      console.log(`[${i + 1}/${imageFiles.length}] Сжатие: ${file}`);
    }
    
    const result = await compressPhoto(inputPath, outputPath);
    
    if (result.success) {
      successCount++;
      totalOriginalSize += result.originalSize;
      totalCompressedSize += result.compressedSize;
      
      if (i % 50 === 0) {
        console.log(`   ✓ ${result.dimensions.width}x${result.dimensions.height}, сжатие: ${result.compressionRatio}%`);
      }
    } else {
      failCount++;
    }
  }
  
  // Статистика
  const totalCompressionRatio = ((1 - totalCompressedSize / totalOriginalSize) * 100).toFixed(1);
  const originalMB = (totalOriginalSize / 1024 / 1024).toFixed(2);
  const compressedMB = (totalCompressedSize / 1024 / 1024).toFixed(2);
  
  console.log('\n✅ Сжатие завершено!');
  console.log(`📊 Успешно: ${successCount}`);
  console.log(`❌ Ошибок: ${failCount}`);
  console.log(`💾 Исходный размер: ${originalMB} MB`);
  console.log(`💾 Сжатый размер: ${compressedMB} MB`);
  console.log(`📉 Общее сжатие: ${totalCompressionRatio}%`);
  console.log(`\n📁 Сжатые фото сохранены в: ${TILES_DIR}`);
}

compressAllPhotos().catch(console.error);

