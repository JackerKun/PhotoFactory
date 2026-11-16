const {spawn}=require('node:child_process');
const root=require('node:path').resolve(__dirname,'../..');
const fsPrep=require('node:fs'),pathPrep=require('node:path');
const cache=pathPrep.join(require('node:os').tmpdir(),'photofactory-doc-capture');fsPrep.mkdirSync(cache,{recursive:true});
const app=fsPrep.realpathSync(fsPrep.mkdtempSync(pathPrep.join(cache,'app-')));
fsPrep.cpSync(pathPrep.join(root,'src'),pathPrep.join(app,'src'),{recursive:true});
for(const name of ['index.html','package.json','tsconfig.json','tailwind.config.js','postcss.config.js'])fsPrep.copyFileSync(pathPrep.join(root,name),pathPrep.join(app,name));
fsPrep.mkdirSync(pathPrep.join(app,'public/demo'),{recursive:true});
fsPrep.cpSync(pathPrep.join(__dirname,'fixtures'),pathPrep.join(app,'public/demo'),{recursive:true});
fsPrep.copyFileSync(pathPrep.join(__dirname,'fixtures/logo.png'),pathPrep.join(app,'public/favicon.ico'));
fsPrep.cpSync(pathPrep.join(root,'node_modules/leaflet/dist/images'),pathPrep.join(app,'public/images'),{recursive:true});
fsPrep.symlinkSync(pathPrep.join(root,'node_modules'),pathPrep.join(app,'node_modules'),process.platform==='win32'?'junction':'dir');
const server=spawn(process.execPath,[pathPrep.join(root,'node_modules/vite/bin/vite.js'),'--config',pathPrep.join(__dirname,'vite.config.mjs')],{cwd:app,env:{...process.env,PHOTOFACTORY_CAPTURE_APP_DIR:app},stdio:'pipe'});
let serverError='';server.stderr.on('data',b=>{serverError+=b.toString()});
async function ready(){for(let i=0;i<80;i++){if(server.exitCode!=null)throw new Error(serverError);try{if((await fetch('http://127.0.0.1:1437')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Documentation server did not start');}
process.on('exit',()=>server.kill());
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PHOTOFACTORY_PLAYWRIGHT_MODULE||'@playwright/test');
const out=process.env.PHOTOFACTORY_SCREENSHOT_DIR||path.join(root,'docs/screenshots');fs.mkdirSync(out,{recursive:true});
(async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  const errors = [];
  const missingCommands = new Set();
  const captures = [];
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      const command = message.text().match(/Unimplemented documentation fixture: (cmd_\w+)/);
      if (command) missingCommands.add(command[1]);
    });
    await ready();
    const base = 'http://127.0.0.1:1437';
    const capture = async (name) => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].filter(image => image.complete).map(image => image.decode().catch(() => {})));
      });
      await page.screenshot({path:path.join(out, name + '.png'), animations:'disabled'});
      captures.push(name);
      console.log('Captured',name);
    };
    const visit = async (route, readyText) => {
      await page.goto(base + '/#' + route);
      await page.getByText(readyText, {exact:true}).first().waitFor();
    };
    await page.goto(base);
    await page.getByText('最近打开的项目').waitFor();
    await page.getByPlaceholder('我的照片').fill('上海漫步 · 演示');
    await page.getByPlaceholder('/path/to/photos').fill('/demo/PhotoFactory');
    await capture('import');
    await page.locator('button').filter({hasText:'/demo/'}).first().click();
    await page.getByText('最近打开的项目').waitFor({state:'hidden'});
    const photo = page.locator('img[src*="/demo/"]').first();
    await photo.waitFor();
    await page.waitForTimeout(450);
    await capture('library');
    await photo.dblclick();
    await page.keyboard.press('i');
    await page.getByText('照片详情', {exact:true}).waitFor();
    await page.waitForTimeout(250);
    await capture('viewer');
    await page.keyboard.press('Escape');
    await visit('/faces', '示例人物 A');
    await capture('people');
    await visit('/tags', '智能分类');
    await page.getByText('山野 · 演示', {exact:true}).first().waitFor();
    await capture('tags');
    await visit('/albums', '全部相册');
    await page.getByText('六月手记 · 演示', {exact:true}).waitFor();
    await capture('albums');
    await page.getByRole('button',{name:'回忆',exact:true}).click();
    await page.getByText('往年此时 · 演示',{exact:true}).waitFor();
    await capture('memories');
    await page.getByText('六月手记 · 演示',{exact:true}).click();
    await page.getByRole('button',{name:/播放回忆/}).waitFor();
    await page.getByText(/选片依据 ·/).click();
    await capture('memory-detail');
    await visit('/library', '智能工具');
    await capture('tools');
    await page.setViewportSize({width:1440,height:1050});
    await page.getByRole('button',{name:'后台任务',exact:true}).click();
    await page.getByText('本地 AI 服务',{exact:true}).waitFor();
    await page.getByText(/服务日志（/).click();
    await page.getByText(/场景分类 · 1 条记录/).click();
    const ignorePhoto = page.getByRole('button',{name:'忽略 DEMO_0035.jpg'});
    await ignorePhoto.scrollIntoViewIfNeeded();
    await capture('diagnostics');
    await page.getByRole('button',{name:'关闭后台任务'}).click();
    await page.setViewportSize({width:1440,height:900});
    await page.goto(base + '/#/map');
    await page.getByRole('button',{name:'拍摄轨迹',exact:true}).click();
    await page.locator('select').filter({has:page.getByRole('option',{name:'上海漫步 · 演示'})}).selectOption('1');
    await page.getByRole('button',{name:'保存轨迹',exact:true}).waitFor();
    const mapStatus = page.locator('.map-load-status');
    await page.waitForFunction(() => document.querySelector('.map-load-status')?.textContent.includes('联网补充'));
    await page.waitForFunction(() => !document.querySelector('.map-load-status')?.textContent.includes('正在加载地图'));
    const retryMap = page.getByRole('button',{name:'重试加载地图'});
    if (await retryMap.isVisible()) {
      await retryMap.click();
      await page.waitForFunction(() => !document.querySelector('.map-load-status')?.textContent.includes('正在加载地图'));
    }
    if (await retryMap.isVisible()) throw new Error(`Map capture has missing tiles: ${await mapStatus.innerText()}`);
    console.log('Map:', await mapStatus.innerText());
    await capture('map');
    console.log('Missing fixture commands:', [...missingCommands].join(', '));
    if (errors.length || missingCommands.size) throw new Error([...errors, ...missingCommands].join('\n'));
    fs.writeFileSync(path.join(out,'capture-report.json'),JSON.stringify({
      mode:'real-react-components-with-mocked-tauri-commands',
      synthetic:true,photos:36,aiResults:'pre-seeded demonstration, not model inference',
      nativeBackendValidated:false,errors,
    },null,2)+'\n');
    require('node:child_process').execFileSync(process.env.PYTHON||'python3',['-c',
      "from PIL import Image; from pathlib import Path; import sys;\nfor name in sys.argv[2:]:\n    png = Path(sys.argv[1]) / (name + '.png')\n    with Image.open(png) as img:\n        img.save(png.with_suffix('.webp'), quality=90)\n    png.unlink()",out,...captures]);
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(app,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
