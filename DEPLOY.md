# Инструкция по деплою на GitHub Pages

## Подготовка фото

Папки `photos/` и `tiles/` добавлены в `.gitignore` и не коммитятся в репозиторий по умолчанию.

### Вариант 1: Временное добавление фото в git (рекомендуется)

Для деплоя на GitHub Pages фото должны быть доступны во время сборки. Самый простой способ:

1. Убедитесь, что папки `photos/` и `tiles/` существуют локально
2. Запустите индексацию: `npm run index-photos`
3. Запустите сжатие: `npm run compress-photos`
4. Временно добавьте фото в git для деплоя:
   ```bash
   git add -f photos/ tiles/
   git commit -m "Add photos for deployment"
   git push
   ```
5. После успешного деплоя можно удалить фото из отслеживания git (опционально):
   ```bash
   git rm -r --cached photos/ tiles/
   git commit -m "Remove photos from git tracking"
   git push
   ```
   **Примечание:** Файлы останутся в истории git, но не будут отслеживаться в будущем.

### Вариант 2: Использование Git LFS (для больших файлов)

Если фото очень большие, используйте Git LFS:

1. Установите Git LFS: `git lfs install`
2. Добавьте фото в LFS:
   ```bash
   git lfs track "photos/**"
   git lfs track "tiles/**"
   git add .gitattributes
   git add photos/ tiles/
   git commit -m "Add photos via Git LFS"
   git push
   ```

### Вариант 3: Отдельный репозиторий для фото

Создайте отдельный репозиторий для фото и используйте GitHub Actions для клонирования перед сборкой (требует настройки workflow).

## Автоматический деплой

Workflow автоматически запускается при пуше в `main` или `master` ветку.

Для ручного запуска:
1. Перейдите в Actions
2. Выберите "Deploy to GitHub Pages"
3. Нажмите "Run workflow"

## Настройка GitHub Pages

1. Перейдите в Settings → Pages
2. Source: выберите "GitHub Actions"
3. Сохраните изменения

После первого деплоя сайт будет доступен по адресу:
`https://<username>.github.io/<repository-name>/`

## Важно

- Фото должны быть в репозитории во время сборки (даже если они в `.gitignore`)
- Используйте `git add -f` для принудительного добавления игнорируемых файлов
- После деплоя можно удалить фото из отслеживания, но они останутся в истории git
