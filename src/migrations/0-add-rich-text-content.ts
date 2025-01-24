import { ManagementClient } from "@kontent-ai/management-sdk";
import {
  parseHTML,
  nodesToHTMLAsync,
  AsyncNodeToHtmlMap,
} from "@kontent-ai/rich-text-resolver";
import { MigrationModule } from "@kontent-ai/data-ops";

/**
 * Async transformers for converting DOM nodes to HTML strings.
 * They each accept:
 *  - The current node
 *  - The recursively resolved child content (as string)
 *  - An optional context object, which in this case is the ManagementClient.
 */
const transformers: AsyncNodeToHtmlMap<ManagementClient> = {
  // Convert <i> to <em>
  i: async (_, children) => `<em>${children}</em>`,

  // Convert <img> to a <figure> referencing an asset uploaded to Kontent.ai
  img: async (node, _, client) =>
    await new Promise<string>(async (resolve, reject) => {
      if (!client) {
        reject("Client is not provided");
        return;
      }

      const src = node.attributes.src;

      if (!src) {
        reject("Invalid IMG tag: no src attribute.");
        return;
      }

      // try getting a filename from URL
      const fileName = src.split("/").pop() || "untitled_file";

      // uploads the asset from URL in the src attribute and returns the asset ID
      const assetId = await client
        .uploadAssetFromUrl()
        .withData({
          // required properties
          binaryFile: {
            filename: fileName,
          },
          fileUrl: src,
          // optional
          asset: {
            title: fileName,
            descriptions: [
              {
                language: { codename: "default" },
                description: node.attributes.alt || "No description",
              },
            ],
            external_id: undefined,
            folder: undefined,
            elements: undefined,
            collection: undefined,
            codename: undefined,
          },
        })
        .toPromise()
        .then((res) => res.data.id)
        .catch((err) => reject(err));

      // transform node to figure, reference asset by ID returned from upload
      resolve(`<figure data-asset-id="${assetId}"></figure>`);
    }),
};

// Migration template created from data-ops `migrations add` command
const migration: MigrationModule = {
  order: 0,
  run: async (apiClient) => {
    const htmlInput = `<p>some normal text and <i>italic text requiring conversion from i to em tag</i></p><img class="content__image" src="https://assets-eu-01.kc-usercontent.com/a917b5bf-e2e1-011e-0a73-0b317b1e1c33/3efaba72-f8af-4e6f-ae02-15ca6d32f6b2/possessed-photography-jIBMSMs4_kA-unsplash.jpg" alt="White robot arm offering handshake">`;
    
    // 1. Parse HTML into DomNode array
    const nodes = parseHTML(htmlInput);

    // 2. Asynchronously transform the nodes into HTML strings, uploading assets in the process
    const transformedRichText = await nodesToHTMLAsync(
      nodes,
      transformers,
      apiClient
    );

    // 3. Create a new item (prerequisite is a content type with a rich text element)
    const itemId = await apiClient
      .addContentItem()
      .withData({
        name: "POC Rich text",
        type: { codename: "rich_text" }, // use valid type codename
      })
      .toPromise()
      .then((res) => res.data.id);
    
    // 4. Upsert the rich text content to the item
    await apiClient
      .upsertLanguageVariant()
      .byItemId(itemId)
      .byLanguageCodename("default") // use valid lang codename
      .withData((builder) => ({
        elements: [
          builder.richTextElement({
            value: transformedRichText,
            element: {
              codename: "rich_text_element", // use valid rich text element codename
            },
          }),
        ],
      }))
      .toPromise();
  },
};

export default migration;
