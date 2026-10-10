import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../styles/tokens.css'
import { MotionProvider } from '../MotionProvider'
import MotionLab from './MotionLab'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionProvider>
      <MotionLab />
    </MotionProvider>
  </StrictMode>
)
