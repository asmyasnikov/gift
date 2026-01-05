import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs'
import { join, resolve } from 'path'

// Простой плагин для копирования папок
function copyFolderPlugin() {
  return {
    name: 'copy-folder',
    closeBundle() {
      const distPath = join(process.cwd(), 'dist')
      
      // Копируем папку tiles полностью (все файлы нужны для мозаики)
      const tilesSrcPath = join(process.cwd(), 'tiles')
      const tilesDestPath = join(distPath, 'tiles')
      
      if (existsSync(tilesSrcPath)) {
        if (!existsSync(tilesDestPath)) {
          mkdirSync(tilesDestPath, { recursive: true })
        }
        
        function copyRecursive(src, dest) {
          const entries = readdirSync(src, { withFileTypes: true })
          
          for (const entry of entries) {
            const srcPath = join(src, entry.name)
            const destPath = join(dest, entry.name)
            
            if (entry.isDirectory()) {
              if (!existsSync(destPath)) {
                mkdirSync(destPath, { recursive: true })
              }
              copyRecursive(srcPath, destPath)
            } else {
              copyFileSync(srcPath, destPath)
            }
          }
        }
        
        copyRecursive(tilesSrcPath, tilesDestPath)
        console.log(`✓ Скопирована папка tiles в dist`)
      }
      
      // Копируем только главные фото из папки photos (JPG с соответствующими PNG масками)
      const photosSrcPath = join(process.cwd(), 'photos')
      const photosDestPath = join(distPath, 'photos')
      
      if (existsSync(photosSrcPath)) {
        if (!existsSync(photosDestPath)) {
          mkdirSync(photosDestPath, { recursive: true })
        }
        
        const entries = readdirSync(photosSrcPath, { withFileTypes: true })
        let copiedCount = 0
        let skippedCount = 0
        
        for (const entry of entries) {
          if (entry.isDirectory()) {
            // Пропускаем подпапки
            continue
          }
          
          const filename = entry.name
          const lowerFilename = filename.toLowerCase()
          
          // Копируем index.json всегда
          if (filename === 'index.json') {
            const srcPath = join(photosSrcPath, filename)
            const destPath = join(photosDestPath, filename)
            copyFileSync(srcPath, destPath)
            copiedCount++
            continue
          }
          
          // Проверяем JPG/JPEG файлы - копируем только если есть соответствующая PNG маска
          if (lowerFilename.endsWith('.jpg') || lowerFilename.endsWith('.jpeg')) {
            const baseName = filename.replace(/\.(jpg|jpeg)$/i, '')
            const maskFilename = `${baseName}.png`
            const maskPath = join(photosSrcPath, maskFilename)
            
            if (existsSync(maskPath)) {
              // Копируем JPG файл
              const jpgSrcPath = join(photosSrcPath, filename)
              const jpgDestPath = join(photosDestPath, filename)
              copyFileSync(jpgSrcPath, jpgDestPath)
              copiedCount++
              
              // Копируем PNG маску
              const pngDestPath = join(photosDestPath, maskFilename)
              copyFileSync(maskPath, pngDestPath)
              copiedCount++
            } else {
              skippedCount++
            }
          }
          // PNG файлы копируем только если они являются масками (уже скопированы выше)
          // Остальные файлы пропускаем
        }
        
        console.log(`✓ Скопирована папка photos в dist (${copiedCount} файлов, пропущено ${skippedCount} файлов без масок)`)
      } else {
        console.warn(`Папка photos не найдена, пропускаем`)
      }
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    copyFolderPlugin()
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  server: {
    port: 3000,
    open: true
  },
  base: './', // Для GitHub Pages используем относительные пути
})



