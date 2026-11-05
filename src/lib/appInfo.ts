import packageJson from '../../package.json'

interface PackageJsonShape {
  name?: string
  version?: string
  build?: {
    productName?: string
  }
}

const packageMetadata = packageJson as PackageJsonShape

function toTitleCaseName(value: string): string {
  return value
    .split(/[-_]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function resolveAppName(): string {
  const configuredName = packageMetadata.build?.productName?.trim()
  if (configuredName) return configuredName

  const packageName = packageMetadata.name?.trim()
  if (!packageName) return 'App'

  return /[-_]/.test(packageName) ? toTitleCaseName(packageName) : packageName
}

export const APP_NAME = resolveAppName()

/** The version in package.json, as the app reports it (e.g. to MCP servers). */
export const APP_VERSION = packageMetadata.version?.trim() || '0.0.0'
