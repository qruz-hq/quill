import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import './todos.css'
import { MotionProvider, connectMainMotion } from '../shared/motion'
import Todos from './Todos'

connectMainMotion()

createRoot(document.getElementById('root')!).render(
  <StrictMode><MotionProvider><Todos /></MotionProvider></StrictMode>
)
