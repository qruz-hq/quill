import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import './scratchpad.css'
import { MotionProvider, connectMainMotion } from '../shared/motion'
import Scratchpad from './Scratchpad'

connectMainMotion()

createRoot(document.getElementById('root')!).render(
  <StrictMode><MotionProvider><Scratchpad /></MotionProvider></StrictMode>
)
