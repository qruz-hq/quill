/**
 * Quill motion foundation. See docs/MOTION.md (spec) and
 * docs/MOTION-IMPLEMENTATION.md (how each surface adopts it).
 */
export * from './tokens'
export { MotionProvider, MotionRoot, useReduceMotion, setReducedMotionOverride, useDocumentVisible, inputModality } from './MotionProvider'
export { useWindowShown, whenWindowShown } from './windowShown'
export { BlurWords, type BlurWordsProps, type BlurPart } from './BlurWords'
export { BlurStream, StreamViewport, type BlurStreamProps, type BlurStreamHandle } from './BlurStream'
export { BlurNumber, formatTimer, type BlurNumberProps, type BlurNumberSize } from './BlurNumber'
export { RealHeight, RealWidth, Indicator, MorphContainer, MorphBox, PresenceSwap, useExitInert, STATE_FADE } from './MorphContainer'
export * as presets from './presets'
export { PRESET } from './presets'
export {
  applyPartial, createPartialFeed, diffTokens, tokenize, normalize,
  type StreamWord, type DiffOp, type PartialResult, type PartialFeed, type FeedResult
} from './wordDiff'
export { filterBudget, largeSurfaceBudget, isLargeSurface } from './filterBudget'
export { animateWord, finishAll, currentOpacity, type WordKeyframes, type AnimHandle } from './waapi'
export { useBarHitTest, shapeRect } from './barHit'
export type { BarHitOptions } from './barHit'
export { connectMainMotion, onWinShown } from './electron'
