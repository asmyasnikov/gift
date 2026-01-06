import fs from 'fs';
import path from 'path';

const PHOTOS_DIR = path.join(process.cwd(), 'photos');
const TILES_DIR = path.join(process.cwd(), 'tiles');
const INDEX_FILE = path.join(PHOTOS_DIR, 'index.json');

// Функция для переименования файла
function renameFile(oldPath, newPath) {
  try {
    fs.renameSync(oldPath, newPath);
    console.log(`✓ Переименован: ${path.basename(oldPath)} -> ${path.basename(newPath)}`);
    return true;
  } catch (error) {
    console.error(`✗ Ошибка переименования ${oldPath}:`, error.message);
    return false;
  }
}

// Функция для переименования файлов в директории
function renameFilesInDir(dir, dirName) {
  if (!fs.existsSync(dir)) {
    console.log(`⚠ Папка ${dirName} не существует, пропускаем`);
    return new Map();
  }
  
  const files = fs.readdirSync(dir);
  const filesWithSpaces = files.filter(file => file.includes(' '));
  
  console.log(`📷 Найдено ${filesWithSpaces.length} файлов с пробелами в ${dirName}\n`);
  
  const renameMap = new Map(); // Старое имя -> новое имя
  
  // Переименовываем файлы
  for (const file of filesWithSpaces) {
    const oldPath = path.join(dir, file);
    const newName = file.replace(/\s+/g, '_'); // Заменяем все пробелы (включая множественные) на подчеркивания
    const newPath = path.join(dir, newName);
    
    // Проверяем, не существует ли уже файл с новым именем
    if (fs.existsSync(newPath) && oldPath !== newPath) {
      console.warn(`⚠ Пропущен ${file} - файл ${newName} уже существует`);
      continue;
    }
    
    if (renameFile(oldPath, newPath)) {
      renameMap.set(file, newName);
    }
  }
  
  return renameMap;
}

async function renameFiles() {
  console.log('🔍 Поиск файлов с пробелами...\n');
  
  // Читаем индекс для обновления
  let index = null;
  try {
    const indexContent = fs.readFileSync(INDEX_FILE, 'utf-8');
    index = JSON.parse(indexContent);
  } catch (error) {
    console.error('Ошибка чтения index.json:', error.message);
    return;
  }
  
  // Переименовываем файлы в photos
  console.log('📁 Обработка папки photos...');
  const photosRenameMap = renameFilesInDir(PHOTOS_DIR, 'photos');
  
  // Переименовываем файлы в tiles
  console.log('\n📁 Обработка папки tiles...');
  const tilesRenameMap = renameFilesInDir(TILES_DIR, 'tiles');
  
  // Обновляем index.json
  if (index && index.photos) {
    let updated = false;
    index.photos.forEach(photo => {
      if (photosRenameMap.has(photo.filename)) {
        photo.filename = photosRenameMap.get(photo.filename);
        updated = true;
      }
    });
    
    if (updated) {
      fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
      console.log('\n✅ index.json обновлен');
    }
  }
  
  const totalRenamed = photosRenameMap.size + tilesRenameMap.size;
  console.log(`\n✅ Переименовано ${totalRenamed} файлов (photos: ${photosRenameMap.size}, tiles: ${tilesRenameMap.size})`);
}

renameFiles().catch(console.error);

