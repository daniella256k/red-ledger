import { HelpIcon, INLINE_LABEL_CLASS, LABEL_CLASS, SectionToggle, ToggleRow, type SettingsSectionProps } from './controls'

export function SearchSection({ settings, saveSettings }: SettingsSectionProps) {
  return (
    <>
      <SectionToggle
        label="Search"
        expanded={settings.searchSectionExpanded}
        onToggle={() =>
          saveSettings({ ...settings, searchSectionExpanded: !settings.searchSectionExpanded })
        }
      />

      {settings.searchSectionExpanded && (
        <>
          <ToggleRow
            label="Offline Mode"
            help="Hide every tool that reaches the network: web, org and wiki search, fetch URL, and HTTP MCP connections. Local (stdio) MCP servers stay available. Chats with a cloud provider still go over the network."
            helpLabel="Offline mode help"
            checked={settings.offlineMode}
            onChange={(checked) => saveSettings({ ...settings, offlineMode: checked })}
          />

          <ToggleRow
            label="Search"
            help="Enable web search through Tavily or SerpApi."
            helpLabel="Search tools help"
            checked={settings.searchToolsEnabled}
            onChange={(checked) => saveSettings({ ...settings, searchToolsEnabled: checked })}
          />

          <fieldset disabled={!settings.searchToolsEnabled} className="space-y-3 disabled:opacity-45">
            {/* Tavily Key */}
            <div>
              <label className={LABEL_CLASS}>Tavily API Key</label>
              <input
                type="password"
                value={settings.tavilyApiKey}
                onChange={(e) => saveSettings({ ...settings, tavilyApiKey: e.target.value })}
                placeholder="tvly-..."
                className="input input-sm input-bordered w-full bg-base-100"
              />
            </div>

            {/* SerpAPI Key */}
            <div>
              <label className={LABEL_CLASS}>SerpAPI Key</label>
              <input
                type="password"
                value={settings.serpApiKey}
                onChange={(e) => saveSettings({ ...settings, serpApiKey: e.target.value })}
                className="input input-sm input-bordered w-full bg-base-100"
              />
            </div>

            {/* Org Site */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className={INLINE_LABEL_CLASS}>Org Site</label>
                <HelpIcon
                  title="Optional. Allows search through a specific source by applying site:example.com."
                  label="Org Site help"
                />
              </div>
              <input
                type="text"
                value={settings.orgSite}
                onChange={(e) => saveSettings({ ...settings, orgSite: e.target.value })}
                placeholder="example.com"
                className="input input-sm input-bordered w-full bg-base-100"
              />
            </div>
          </fieldset>
        </>
      )}
    </>
  )
}
