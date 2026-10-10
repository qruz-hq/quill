import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import { MotionProvider, connectMainMotion } from '../shared/motion'
import App from './App'

connectMainMotion()

createRoot(document.getElementById('root')!).render(
  <StrictMode><MotionProvider><App /></MotionProvider></StrictMode>
)
