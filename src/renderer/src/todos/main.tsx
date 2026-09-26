import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'
import './todos.css'
import Todos from './Todos'

createRoot(document.getElementById('root')!).render(
  <StrictMode><Todos /></StrictMode>
)
