# Rich Text Migration PoC

A simple PoC for transforming HTML into valid Kontent.ai rich text using the `@kontent-ai/rich-text-resolver` package. The data-ops migration CLI is used to run the script and upsert data into Kontent.ai.

## Usage

> [!NOTE]  
> The migration assumes you have a content type with codename `rich_text`, containing a rich text element with codename `rich_text_element`. There should also be `default` language in your environment. Create the type manually or adjust the migration code to correspond with your type.

1. Clone and install dependencies:
    ```bash
    npm i
    ```

2. Run the build command:
    ```bash
    npm run build
    ```
3. Run the migration (point to `Migrations` folder created by build command, provide valid environment ID and API key)
    ```bash
    npx @kontent-ai/data-ops@latest migrations run --migrationsFolder ./Migrations --environmentId <environment-id> --apiKey <api-key> --all --skipConfirmation
    ```