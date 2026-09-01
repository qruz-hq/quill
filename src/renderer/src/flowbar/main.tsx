import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import './flowbar.css'
import FlowBar from './FlowBar'

createRoot(document.getElementById('root')!).render(
  <StrictMode><FlowBar /></StrictMode>
)
