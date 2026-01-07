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
      
      // Копируем все JPEG и PNG файлы из папки photos
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
          
          // Копируем все JPEG файлы (jpg, jpeg)
          if (lowerFilename.endsWith('.jpg') || lowerFilename.endsWith('.jpeg')) {
            const srcPath = join(photosSrcPath, filename)
            const destPath = join(photosDestPath, filename)
            copyFileSync(srcPath, destPath)
            copiedCount++
            continue
          }
          
          // Копируем все PNG файлы
          if (lowerFilename.endsWith('.png')) {
            const srcPath = join(photosSrcPath, filename)
            const destPath = join(photosDestPath, filename)
            copyFileSync(srcPath, destPath)
            copiedCount++
            continue
          }
          
          // Остальные файлы пропускаем
          skippedCount++
        }
        
        console.log(`✓ Скопирована папка photos в dist (${copiedCount} файлов, пропущено ${skippedCount} файлов)`)
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



