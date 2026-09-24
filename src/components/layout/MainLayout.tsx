import { useCallback, lazy, Suspense } from 'react'
import { motion } from 'framer-motion'
import TopBar from './TopBar'
import ResizeHandle from './ResizeHandle'
import FileTree from '@/components/fileTree/FileTree'
import GraphPanel from '@/components/graph/GraphPanel'
import PhysicsControls from '@/components/graph/PhysicsControls'
import StatusBar from './StatusBar'
import ToastContainer from '@/components/shared/ToastContainer'
import CommandPalette from '@/components/shared/CommandPalette'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useT } from '@/i18n'

const SettingsPanel = lazy(() => import('@/components/settings/SettingsPanel'))
const ConverterEditor = lazy(() => import('@/components/converter/ConverterEditor'))
const MarkdownEditor = lazy(() => import('@/components/editor/MarkdownEditor'))
const ImageViewer = lazy(() => import('@/components/editor/ImageViewer'))
const ReportViewer = lazy(() => import('@/components/editor/ReportViewer'))
const SlackLogViewer = lazy(() => import('@/components/slackLog/SlackLogViewer'))
const MyDeskPanel = lazy(() => import('@/components/me/MyDeskPanel'))

const LEFT_MIN = 140
const LEFT_MAX = 340

const PANEL_SPRING = { type: 'spring', stiffness: 80, damping: 18, delay: 0.15 } as const
const OVERLAY_TRANSITION = { duration: 0.2 }
const COLLAPSE_TRANSITION = { type: 'spring', stiffness: 300, damping: 30 } as const
const NO_TRANSITION = { duration: 0 } as const

export default function MainLayout() {
  const t = useT()
  const {
    centerTab, editingDocId, leftPanelCollapsed,
    leftPanelWidth: leftWidth,
    setLeftPanelWidth,
  } = useUIStore()
  const isFast = useSettingsStore(s => s.paragraphRenderQuality === 'fast')

  // Panels appear in place (no entry animation): while the 3D graph is building, frames are slow
  // enough that a spring driven by framer-motion's clamped frame delta would crawl for a minute.
  const panelTransition   = isFast ? NO_TRANSITION : PANEL_SPRING
  const overlayTransition = isFast ? NO_TRANSITION : OVERLAY_TRANSITION
  const collapseTransition = isFast ? NO_TRANSITION : COLLAPSE_TRANSITION

  const solidPanel = {
    background: 'var(--color-bg-secondary)',
    overflow: 'hidden' as const,
  }

  const handleLeftResize = useCallback((delta: number) => {
    const w = useUIStore.getState().leftPanelWidth
    setLeftPanelWidth(Math.min(LEFT_MAX, Math.max(LEFT_MIN, w + delta)))
  }, [setLeftPanelWidth])

  return (
    <div
      data-perf={isFast ? 'fast' : undefined}
      style={{
        height: '100vh',
        background: 'var(--color-bg-primary)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Graph — fills full viewport as persistent background */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
        <ErrorBoundary fallback={
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--color-text-muted)', fontSize: '0.875rem',
          }}>
            {t('Graph rendering failed. Click to retry.')}
          </div>
        }>
          <GraphPanel />
        </ErrorBoundary>
      </div>

      {/* Floating UI shell — pointer-events:none so clicks fall through to graph */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'none',
        }}
      >
        {/* TopBar — flush top, full width */}
        <motion.div
          initial={false}
          animate={{ y: 0, opacity: 1 }}
          transition={panelTransition}
          style={{
            flexShrink: 0,
            pointerEvents: 'auto',
            ...solidPanel,
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <TopBar />
        </motion.div>

        {/* Main content row */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

          {/* Left panel — File tree */}
          <motion.div
            initial={false}
            animate={{
              x: 0,
              opacity: leftPanelCollapsed ? 0 : 1,
              width: leftPanelCollapsed ? 0 : leftWidth,
            }}
            transition={leftPanelCollapsed ? collapseTransition : panelTransition}
            style={{
              minWidth: leftPanelCollapsed ? 0 : leftWidth,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              pointerEvents: leftPanelCollapsed ? 'none' : 'auto',
              ...solidPanel,
              borderRight: '1px solid var(--color-border)',
            }}
          >
            <FileTree />
          </motion.div>

          {/* Left resize handle */}
          {!leftPanelCollapsed && (
            <div style={{ pointerEvents: 'auto', flexShrink: 0, background: 'var(--color-bg-secondary)' }}>
              <ResizeHandle onResize={handleLeftResize} />
            </div>
          )}

          {/* Center — transparent (graph shows through) */}
          <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
            {/* Physics controls */}
            {centerTab !== 'editor' && centerTab !== 'settings' && centerTab !== 'slack-logs' && !isFast && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 12,
                  right: 12,
                  zIndex: 5,
                  pointerEvents: 'auto',
                }}
              >
                <PhysicsControls />
              </div>
            )}

            {/* Editor / Settings / Slack logs overlay */}
            {(centerTab === 'editor' || centerTab === 'settings' || centerTab === 'slack-logs' || centerTab === 'me') && (
              <motion.div
                key={centerTab === 'settings' ? 'settings' : centerTab === 'slack-logs' ? 'slack-logs' : centerTab === 'me' ? 'me' : (editingDocId ?? 'converter')}
                initial={false}
                animate={{ opacity: 1 }}
                transition={overlayTransition}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  pointerEvents: 'auto',
                  ...solidPanel,
                }}
              >
                <Suspense fallback={<div role="status" style={{ padding: 24 }}>{t('Loading...')}</div>}>
                {centerTab === 'settings'
                  ? <SettingsPanel />
                  : centerTab === 'me'
                  ? <MyDeskPanel />
                  : centerTab === 'slack-logs'
                    ? <SlackLogViewer />
                    : editingDocId?.startsWith('gallery:')
                      ? <ImageViewer />
                      : editingDocId?.startsWith('report:')
                        ? <ReportViewer />
                        : editingDocId
                          ? <MarkdownEditor />
                          : <ConverterEditor />
                }
                </Suspense>
              </motion.div>
            )}
          </div>

        </div>

        {/* StatusBar — bottom, full width */}
        <div style={{ flexShrink: 0, pointerEvents: 'auto' }}>
          <StatusBar />
        </div>
      </div>

      {/* Portals — rendered outside the pointer-events:none shell */}
      <ToastContainer />
      <CommandPalette />
    </div>
  )
}
