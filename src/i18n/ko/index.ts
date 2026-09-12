// One file per component area so parallel edits never collide; merged here.
import common from './common'
import settingsPanel from './settingsPanel'
import settingsTabsA from './settingsTabsA'
import settingsTabsB from './settingsTabsB'
import settingsTabsC from './settingsTabsC'
import editor from './editor'
import graph from './graph'
import layout from './layout'
import web from './web'
import chat from './chat'
import converter from './converter'
import docViewer from './docViewer'
import fileTree from './fileTree'
import shared from './shared'

export const ko: Record<string, string> = {
  ...common, ...settingsPanel, ...settingsTabsA, ...settingsTabsB, ...settingsTabsC,
  ...editor, ...graph, ...layout, ...web, ...chat, ...converter, ...docViewer, ...fileTree, ...shared,
}
