import type { FlowApi, Perms, MicAccess, Notice, NoticeKind, TransformApplied, SettingsPane, CloseRequest, WinShown, PracticeResult } from './index'
declare global {
  interface Window { flow: FlowApi }
  type FlowPerms = Perms
  type FlowMicAccess = MicAccess
  type FlowNotice = Notice
  type FlowNoticeKind = NoticeKind
  type FlowTransformApplied = TransformApplied
  type FlowSettingsPane = SettingsPane
  type FlowCloseRequest = CloseRequest
  type FlowWinShown = WinShown
  type FlowPracticeResult = PracticeResult
}
