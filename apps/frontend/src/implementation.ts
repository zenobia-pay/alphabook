import { getImplementationConfig } from "@alphabook/implementations";

export function resolveFrontendImplementation() {
  const implementationId = (import.meta.env.VITE_IMPLEMENTATION_ID as string | undefined) ?? "alphabook";
  const base = getImplementationConfig(implementationId);
  return {
    ...base,
    productName: (import.meta.env.VITE_PRODUCT_NAME as string | undefined) ?? base.productName,
    defaultReaderName: (import.meta.env.VITE_DEFAULT_READER_NAME as string | undefined) ?? base.defaultReaderName,
    siteName: (import.meta.env.VITE_SITE_NAME as string | undefined) ?? base.siteName,
    siteOrigin: (import.meta.env.VITE_SITE_ORIGIN as string | undefined) ?? base.siteOrigin,
    contentOrigin: (import.meta.env.VITE_CONTENT_ORIGIN as string | undefined) ?? base.contentOrigin,
    siteDescription: (import.meta.env.VITE_SITE_DESCRIPTION as string | undefined) ?? base.siteDescription,
    themeColor: (import.meta.env.VITE_THEME_COLOR as string | undefined) ?? base.themeColor,
    ogImageUrl: (import.meta.env.VITE_OG_IMAGE_URL as string | undefined) ?? base.ogImageUrl,
  };
}
