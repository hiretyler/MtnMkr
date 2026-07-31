import ReactDOM from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './sw-client'
import './ui.css'

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)

registerServiceWorker()
