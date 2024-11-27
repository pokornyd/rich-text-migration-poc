import { MigrationModule } from "@kontent-ai/data-ops";
import {
  DomHtmlNode,
  DomNode,
  isElement,
  parse,
  TransformNodeFunctionAsync,
  traverseAndTransformNodesAsync,
} from "@kontent-ai/rich-text-resolver";
import axios from "axios";
import { ManagementClient } from "@kontent-ai/management-sdk";
import puppeteer from "puppeteer";

// ideally, you'd have a custom method to get the content in some better way (API), rather than scraping the actual HTML
const fetchHtml = async (url: string): Promise<string> => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle0' });
  const content = await page.content();
  await browser.close();
  return content;
};

// this is not an optimal solution. consider using DOMParser or node-html-parser to retrieve values from non-rich-text elements
const findNodeByClassName = (
  parsed: DomNode[],
  className: string
): DomHtmlNode | undefined => {
  return parsed
    .filter(isElement)
    .reduce<DomHtmlNode | undefined>((acc, node) => {
      if (acc) return acc;

      if (node.attributes["class"] === className) {
        return node;
      }

      return findNodeByClassName(node.children || [], className);
    }, undefined);
};

/**
 * callback method for transforming each node of the JSON tree back to MAPI compatible HTML, with ManagementClient provided via context.
 * 
 * leaves most nodes as-is, but eliminates unsupported attributes (class, style etc.).
 * 
 * for img nodes, bytes are retrieved by axios from `src` attribute and an asset subsequently upserted to kontent.ai environment using the
 * two step process: https://kontent.ai/learn/docs/apis/openapi/management-api-v2/#tag/Assets. finally, the img node is transformed into <figure>,
 * with data-asset-id attribute pointing to the previously uploaded asset.
 * 
 **/ 
const transformNodeToMapiRichText: TransformNodeFunctionAsync<
  DomNode,
  { client: ManagementClient },
  string
> = async (node, processedItems, context) => {
  if (isElement(node)) {
    if (node.tagName === "img" && node.attributes.src) {
      try {
        // fetch the image binary data
        const response = await axios.get(node.attributes.src, {
          responseType: "arraybuffer",
        });
        const data = response.data;
        const contentType = response.headers["content-type"];
        const filename =
          new URL(node.attributes.src).pathname.split("/").pop() ||
          "unknown-file"; // try getting file name from its path

        // Upload the binary file
        const uploadResponse = await context?.client
          .uploadBinaryFile()
          .withData({
            binaryData: data,
            contentLength: data.byteLength,
            contentType: contentType || "application/octet-stream",
            filename,
          })
          .toPromise();

        const fileReference = {
          id: uploadResponse?.data.id as string,
          type: "internal" as const,
        };

        // Create the asset object 
        const assetResponse = await context?.client
          .addAsset()
          .withData(() => ({
            file_reference: fileReference,
            title: filename,
            descriptions: [
              {
                language: { codename: "default" },
                description: "Auto-generated asset", // consider using "alt" attribute if present (or AI?)
              },
            ],
          }))
          .toPromise();

        // Transform the node to a "figure" with the asset ID
        return [`<figure data-asset-id="${assetResponse?.data.id}"></figure>`];
      } catch (error) {
        console.error("Error processing image node:", error);
        // Fallback to original HTML representation of the img node
        return [`<${node.tagName}/>`];
      }
    }

    if (node.tagName === "someothertag") {
      // implement custom processing for other tags if needed...
    }

    const innerHtml = processedItems.join(""); // already processed subnodes are returned as arrays. join them to get the full inner HTML.

    return [ // for any other node than img, just create opening and closing tags and remove unsupported attributes.
      `<${node.tagName} ${serializeKnownAttributes(
        node.attributes
      )}>${innerHtml}</${node.tagName}>`,
    ];
  } else {
    return [node.content]; // for text nodes, just return their content
  }
};

const allowedRichTextElementAttributes = [
  "data-item-id",
  "data-item-external-id",
  "data-item-codename",
  "data-asset-id",
  "data-asset-external-id",
  "data-asset-codename",
  "data-new-window",
  "title",
  "target",
  "href",
  "data-image-id",
  "data-rel",
  "data-type",
  "data-codename",
  "data-id",
  "data-external-id",
  "src",
  "type",
  "data-id",
  "data-email-address",
  "data-email-subject",
  "data-phone-number",
];

// Utility to serialize attributes to HTML, removing the unsupported ones
const serializeKnownAttributes = (
  attributes: Record<string, string | undefined>
): string =>
  Object.entries(attributes)
    .filter(([key]) => allowedRichTextElementAttributes.includes(key)) // get rid of unsupported attributes
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");

const migration: MigrationModule = {
  order: 0,
  run: async (apiClient) => {
    const htmlString = await fetchHtml("https://migration-poc.vercel.app/");
    const parsedHtml = parse(htmlString);
    const parsedRichText = findNodeByClassName(
      parsedHtml,
      "content__body"
    )?.children;
    const headingSection = findNodeByClassName(parsedHtml, "block__heading");

    if (!parsedRichText) throw new Error("No rich text content found.");

    const titleNode = headingSection?.children[0] as DomHtmlNode; // this is ugly, but works for this case.
    const dateNode = headingSection?.children[1] as DomHtmlNode;

    const title =
      titleNode.children[0]?.type === "text"
        ? titleNode.children[0].content
        : "Title not found";
    const date =
      dateNode.children[0]?.type === "text"
        ? dateNode.children[0].content
        : "Date not found";

    const context = {
      client: apiClient,
    };

    const transformedRichText = await traverseAndTransformNodesAsync(
      parsedRichText,
      transformNodeToMapiRichText,
      context
    ).then((result) => result.join(""));

    const itemId = await apiClient
      .addContentItem()
      .withData({
        name: title,
        type: { codename: "article" },
      })
      .toPromise()
      .then(res => res.data.id);

    await apiClient
      .upsertLanguageVariant()
      .byItemId(itemId)
      .byLanguageCodename("default") // or whichever language you want
      .withData((builder) => ({
        elements: [
          builder.textElement({
            value: title,
            element: {
              codename: "title",
            },
          }),
          builder.dateTimeElement({
            value: date,
            display_timezone: "UTC",
            element: {
              codename: "publishing_date",
            },
          }),
          builder.richTextElement({
            value: transformedRichText,
            element: {
              codename: "content",
            },
          }),
        ],
      }))
      .toPromise();
  },
};

export default migration;
