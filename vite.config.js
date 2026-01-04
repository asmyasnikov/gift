import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'

// Простой плагин для копирования папок
function copyFolderPlugin() {
  return {
    name: 'copy-folder',
    closeBundle() {
      const foldersToCopy = ['photos', 'tiles']
      const distPath = join(process.cwd(), 'dist')
      
      foldersToCopy.forEach(folder => {
        const srcPath = join(process.cwd(), folder)
        const destPath = join(distPath, folder)
        
        if (!existsSync(srcPath)) {
          console.warn(`Папка ${folder} не найдена, пропускаем`)
          return
        }
        
        // Создаем папку назначения
        if (!existsSync(destPath)) {
          mkdirSync(destPath, { recursive: true })
        }
        
        // Копируем файлы рекурсивно
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
        
        copyRecursive(srcPath, destPath)
        console.log(`✓ Скопирована папка ${folder} в dist`)
      })
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    copyFolderPlugin()
  ],
  server: {
    port: 3000,
    open: true
  },
  base: './', // Для GitHub Pages используем относительные пути
})



