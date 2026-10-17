import { createRoot } from 'react-dom/client'
import RemoteApp from './RemoteApp'
import './remote.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root container missing')

createRoot(container).render(<RemoteApp />)
