import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import './flowbar.css'
import { MotionProvider, connectMainMotion } from '../shared/motion'
import FlowBar from './FlowBar'

connectMainMotion()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionProvider>
      <FlowBar />
    </MotionProvider>
  </StrictMode>
)
