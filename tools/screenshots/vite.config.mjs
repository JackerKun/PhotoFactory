import {defineConfig} from '../../node_modules/vite/dist/node/index.js';
import react from '../../node_modules/@vitejs/plugin-react/dist/index.js';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({root:process.env.PHOTOFACTORY_CAPTURE_APP_DIR,plugins:[react()],resolve:{alias:{'@tauri-apps/api/core':here+'core.ts','@tauri-apps/api/event':here+'event.ts','@tauri-apps/plugin-dialog':here+'dialog.ts'}},server:{host:'127.0.0.1',port:1437,strictPort:true,fs:{allow:[here,process.env.PHOTOFACTORY_CAPTURE_APP_DIR,here+'../../node_modules']}},optimizeDeps:{exclude:['@tauri-apps/api/core','@tauri-apps/api/event','@tauri-apps/plugin-dialog']}});
