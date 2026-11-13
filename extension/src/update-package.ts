export const REPOSITORY = "tuturuleo/tvissn";
export type PackageType = "exe" | "zip";
export type UpdatePackage = { downloadUrl: string; packageType: PackageType };

// Only public release assets from this repository may be downloaded.
export function selectUpdatePackage(assets: unknown, os: string): UpdatePackage | null {
  if (!Array.isArray(assets)) return null;
  const names: [string, PackageType][] = os === "win"
    ? [["tvissn-extension-setup.exe", "exe"], ["tvissn-extension.zip", "zip"]]
    : [["tvissn-extension.zip", "zip"]];
  for (const [name, packageType] of names) {
    for (const asset of assets) {
      if (asset?.name !== name || typeof asset.browser_download_url !== "string") continue;
      try {
        const url = new URL(asset.browser_download_url);
        if (url.origin === "https://github.com" && !url.username && !url.password &&
            url.pathname.startsWith(`/${REPOSITORY}/releases/download/`) &&
            url.pathname.split("/").length === 7 &&
            url.pathname.endsWith(`/${name}`) && !url.search && !url.hash) {
          return { downloadUrl: url.href, packageType };
        }
      } catch { /* Ignore malformed URLs and try another asset. */ }
    }
  }
  return null;
}
