import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { AccountSection } from '@/components/settings/AccountSection'
import { ChangePasswordSection } from '@/components/settings/ChangePasswordSection'
import { AtlasDataOverview } from '@/components/settings/AtlasDataOverview'
import { AtlasSection } from '@/components/settings/AtlasSection'
import { SheetsSection } from '@/components/settings/SheetsSection'
import { SourcesOverviewTable } from '@/components/settings/SourcesOverviewTable'
import { SupabaseSection } from '@/components/settings/SupabaseSection'
import { TranscriptStoreSection } from '@/components/settings/TranscriptStoreSection'
import { ZoomBotSection } from '@/components/settings/ZoomBotSection'
import { DiscordSection } from '@/components/settings/DiscordSection'
import { NotificationsSection } from '@/components/settings/NotificationsSection'
import { TagsSection } from '@/components/settings/TagsSection'
import { TaskTemplatesSection } from '@/components/settings/TaskTemplatesSection'
import { WorkspaceSection } from '@/components/settings/WorkspaceSection'
import { useAuth } from '@/data/auth'
import { useData } from '@/data/store'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

/** Shared card frame for every settings section. The interior is
 *  driven by each section component (they own their heading + body);
 *  the wrapper only provides the consistent rounded surface, border,
 *  and padding the page-level spec calls for. */
function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6">
      {children}
    </div>
  )
}

export default function SettingsPage() {
  useDocumentTitle('Settings')
  const { isPM } = useAuth()
  const location = useLocation()

  // Deep-link support: `/settings#password` (from the top-bar menu) scrolls
  // the change-password card into view. Delayed a frame so the section is
  // mounted before we ask for its position.
  useEffect(() => {
    if (location.hash !== '#password') return
    const t = window.setTimeout(() => {
      const el = document.getElementById('password')
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
    return () => window.clearTimeout(t)
  }, [location.hash])
  // Atlas Data Overview only renders content when the data source is
  // 'atlas'. We mirror that gating here so we don't render an empty
  // card or break the 2-col layout with a null child.
  const { dataSource } = useData()
  const showDataOverview = isPM && dataSource === 'atlas'

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
          Settings
        </h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {isPM
            ? 'Manage your workspace, tags, notifications, and profile.'
            : 'Manage your notifications and profile.'}
        </p>
      </header>

      {/* Top-of-page summary of every data source the app talks to.
          Sits above the per-source configuration cards so PMs can see
          overall health before drilling into a specific integration. */}
      {isPM && (
        <SettingsCard>
          <SourcesOverviewTable />
        </SettingsCard>
      )}

      {isPM && (
        <SettingsCard>
          <ZoomBotSection />
        </SettingsCard>
      )}

      {isPM && (
        <SettingsCard>
          <TranscriptStoreSection />
        </SettingsCard>
      )}

      {isPM &&
        (showDataOverview ? (
          // Side-by-side on lg+ — API connection on the left, the
          // live data summary on the right. Stack on smaller widths.
          <div className="grid gap-6 lg:grid-cols-2">
            <SettingsCard>
              <AtlasSection />
            </SettingsCard>
            <SettingsCard>
              <AtlasDataOverview />
            </SettingsCard>
          </div>
        ) : (
          <SettingsCard>
            <AtlasSection />
          </SettingsCard>
        ))}

      {isPM && (
        <SettingsCard>
          <SheetsSection />
        </SettingsCard>
      )}

      {isPM && (
        <SettingsCard>
          <SupabaseSection />
        </SettingsCard>
      )}

      {isPM && (
        <SettingsCard>
          <WorkspaceSection />
        </SettingsCard>
      )}
      {isPM && (
        <SettingsCard>
          <TagsSection />
        </SettingsCard>
      )}
      {isPM && (
        <SettingsCard>
          <TaskTemplatesSection />
        </SettingsCard>
      )}
      {isPM && (
        <SettingsCard>
          <DiscordSection />
        </SettingsCard>
      )}
      <SettingsCard>
        <NotificationsSection />
      </SettingsCard>
      <SettingsCard>
        <AccountSection />
      </SettingsCard>
      <SettingsCard>
        <div id="password" className="scroll-mt-6">
          <ChangePasswordSection />
        </div>
      </SettingsCard>
    </div>
  )
}
