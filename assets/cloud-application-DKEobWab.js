import{c as I,a as T,S as P,b as V,r as J,g as j,d as B,L as W,e as u,v as D,f as M,m as q}from"./index-CgXxUXPL.js";import{C as y,r as O}from"./supabase-backend-DWLOdSW1.js";function w(h){const{updatedAt:e,...t}=h;return JSON.stringify(t,(o,i)=>i&&typeof i=="object"&&!Array.isArray(i)?Object.fromEntries(Object.entries(i).sort(([n],[a])=>n<a?-1:n>a?1:0)):i)}class _{constructor(e,t,o){this.backend=e,this.cache=o,this.pending=!1,this.conflict=!1,this.recovery=null,this.cacheWarning="",this.onChange=()=>{},this.version=t.version;let i=t.model??I();this.baseline=t.model?w(i):"";try{const n=o.read();if(n){const a=n.model;this.recovery=n;const f=n.unsaved;f&&n.baseVersion!==t.version?this.conflict=!0:f?i=a:this.recovery=null}}catch{this.conflict=!0,this.cacheWarning="本机恢复副本无法完整读取，请先下载副本，再选择使用云端数据。"}this.store=T({initialState:i,persistence:{load:()=>i,save:n=>(this.writeCache(n),{state:n,sizeBytes:new Blob([JSON.stringify(n)]).size,nearCapacity:!1}),clear:()=>{}}}),t.model&&!this.recovery&&(this.baseline=w(this.store.getState().model)),this.unsubscribe=this.store.subscribe(()=>this.onChange())}get busy(){return this.pending}get recoveryConflict(){return this.conflict}get cloudVersion(){return this.version}get hasUnsavedChanges(){return this.conflict||w(this.store.getState().model)!==this.baseline}writeCache(e){if(this.conflict)throw new y("conflict","本机旧恢复副本尚未处理，未覆盖它。");this.cache.write({baseVersion:this.version,unsaved:w(e)!==this.baseline,model:e}),this.cacheWarning=""}stash(){this.writeCache(this.store.getState().model)}recoveryJson(){return this.conflict?this.cache.raw()??"":JSON.stringify({baseVersion:this.version,model:this.store.getState().model},null,2)}discardRecovery(){this.cache.remove(),this.conflict=!1,this.recovery=null,this.cacheWarning="",this.onChange()}importLocal(e){if(this.version!==0||this.pending||this.conflict)throw new y("invalid","只有空云端工作区可以接收首次本机迁移。");this.store.getState().replaceModel(e),this.stash()}restoreRecovery(e){if(this.pending||this.conflict)throw new y("conflict","请先处理本机旧副本或等待当前操作完成。");this.store.getState().replaceModel(e),this.stash()}async run(e){if(this.pending||this.conflict)throw new y("conflict","请先完成当前操作或处理本机恢复副本。");this.pending=!0,this.onChange();try{return await e()}finally{this.pending=!1,this.onChange()}}async save(){return this.run(async()=>{const e=structuredClone(this.store.getState().model);try{this.stash()}catch{this.cacheWarning="本机恢复副本保存失败，请下载副本备份。"}const t=await this.backend.save(this.version,e);this.version=t,this.baseline=w(e);try{this.stash()}catch{this.cacheWarning="云端已保存，但本机恢复副本未更新，请下载备份。"}})}async publish(){return this.run(async()=>{if(this.hasUnsavedChanges)throw new y("invalid","请先保存到云端，再发布班表。");const e=this.store.getState().model;if(!e.activeScheduleDate||!e.assignments.length||e.schedulePolicyStale)throw new y("invalid","当前没有可发布的有效班表，请先重新排班。");return this.backend.publish(this.version,e.activeGroupId)})}dispose(){this.unsubscribe()}}async function z(h){const e=JSON.parse(await h.text());if(typeof e!="object"||e===null||!("model"in e))throw new Error("这不是完整云端恢复副本；Excel请使用工作台原有导入入口。");return O(e.model)}function F(h,e,t=localStorage){const o=`autoschedule.cloud.v1:${h}:${e}`,i=`${o}:recovery`;return{recovery:{read(){const n=t.getItem(i);if(!n)return null;const a=JSON.parse(n);if(!Number.isSafeInteger(a.baseVersion)||a.baseVersion<0||typeof a.unsaved!="boolean")throw new Error("恢复副本版本无效");return{baseVersion:a.baseVersion,unsaved:a.unsaved,model:O(a.model)}},write:n=>t.setItem(i,JSON.stringify(n)),raw:()=>t.getItem(i),remove:()=>t.removeItem(i)},preferences:B({getItem:n=>t.getItem(`${o}:${n}`),setItem:(n,a)=>t.setItem(`${o}:${n}`,a)}),loadLocalModel(){const n=t.getItem(P);if(!n)return null;V();const a=J(JSON.parse(n),I());if(!a||j().issues.length)throw new Error("原本地数据未能完整恢复，未迁移，请先检查Excel备份。");return a}}}class R extends W{static{this.properties={state:{attribute:!1}}}command(e){this.dispatchEvent(new CustomEvent("cloud-command",{detail:e,bubbles:!0}))}render(){const e=this.state;return e?u`<section
      class="container-fluid border-bottom bg-light p-3"
      aria-label="云端工作区"
    >
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <strong>云端工作区</strong>
        <span role="status"
          >${e.phase==="editor"?e.dirty?"有修改未上传":`已保存到云端 · 版本 ${e.version}`:""}</span
        >
        ${e.phase==="editor"?u`
                <button
                  class="btn btn-primary btn-sm"
                  ?disabled=${e.busy||e.conflict}
                  @click=${()=>this.command({type:"save"})}
                >
                  保存到云端
                </button>
                <button
                  class="btn btn-outline-primary btn-sm"
                  ?disabled=${e.busy||e.conflict||e.dirty}
                  @click=${()=>this.command({type:"publish"})}
                >
                  发布当前组班表
                </button>
                <button
                  class="btn btn-outline-secondary btn-sm"
                  ?disabled=${e.busy}
                  @click=${()=>this.command({type:"download"})}
                >
                  下载恢复副本
                </button>
                <label class="btn btn-outline-secondary btn-sm mb-0"
                  >导入恢复副本<input
                    class="visually-hidden"
                    type="file"
                    accept=".json,application/json"
                    ?disabled=${e.busy||e.conflict}
                    @change=${this.restore}
                /></label>
                ${e.canImport?u`<button class="btn btn-outline-secondary btn-sm" ?disabled=${e.busy||e.conflict} @click=${()=>this.command({type:"import-local"})}>首次从本机迁移</button>`:null}
                <button
                  class="btn btn-outline-secondary btn-sm"
                  ?disabled=${e.busy}
                  @click=${()=>this.command({type:"logout"})}
                >
                  退出登录
                </button>
              `:null}
      </div>
      ${e.phase==="login"?u`
              <form class="d-flex flex-wrap gap-2 mt-3" @submit=${this.login}>
                <label
                  >管理员邮箱<input
                    name="email"
                    class="form-control"
                    type="email"
                    autocomplete="username"
                    required
                    ?disabled=${e.busy}
                /></label>
                <label
                  >密码<input
                    name="password"
                    class="form-control"
                    type="password"
                    autocomplete="current-password"
                    required
                    ?disabled=${e.busy}
                /></label>
                <button
                  class="btn btn-primary align-self-end"
                  type="submit"
                  ?disabled=${e.busy}
                >
                  登录
                </button>
              </form>
              <p class="small text-secondary mt-2 mb-0">
                仅管理员可修改。查看班表请打开管理员提供的发布链接。
              </p>
            `:null}
      ${e.message?u`<p class="mt-2 mb-0" role="status">${e.message}</p>`:null}
      ${e.cacheWarning?u`<p class="mt-2 mb-0 text-danger" role="alert">${e.cacheWarning}</p>`:null}
      ${e.conflict?u`
              <p class="mt-2 mb-1 text-danger" role="alert">
                本机有尚未上传的旧副本，云端已有不同版本。编辑已暂停，请先下载副本备份。
              </p>
              <button
                class="btn btn-outline-danger btn-sm"
                ?disabled=${e.busy}
                @click=${()=>this.command({type:"discard"})}
              >
                放弃本机旧副本，使用云端数据
              </button>
            `:null}
      ${e.phase==="editor"?u`<p class="small text-secondary mt-2 mb-0">编辑后请点“保存到云端”，换电脑才能接续。只有点“发布”才会更新公开班表；发布内容不含配置、草稿或历史库。</p>`:null}
      ${e.shareUrl?u`<label class="d-block mt-2">查看链接<input class="form-control" readonly .value=${e.shareUrl} @focus=${t=>t.target.select()} /></label>`:null}
      ${e.phase==="error"?u`
              <button
                class="btn btn-outline-primary btn-sm mt-2"
                ?disabled=${e.busy}
                @click=${()=>this.command({type:"retry"})}
              >
                重新连接
              </button>
              <button
                class="btn btn-outline-secondary btn-sm mt-2"
                ?disabled=${e.busy}
                @click=${()=>this.command({type:"logout"})}
              >
                退出当前登录
              </button>
            `:null}
    </section>`:null}login(e){e.preventDefault();const t=e.currentTarget,o=new FormData(t),i={type:"login",email:String(o.get("email")??"").trim(),password:String(o.get("password")??"")};t.reset(),this.command(i)}restore(e){const t=e.currentTarget,o=t.files?.[0];t.value="",o&&this.command({type:"restore",file:o})}}customElements.define("autoschedule-cloud-panel",R);class U extends W{constructor(){super(...arguments),this.schedule=null,this.message="正在读取已发布班表…"}static{this.properties={schedule:{attribute:!1},message:{}}}render(){const e=this.schedule;return u`<main class="container py-4">
      <h1 class="h3">已发布班表</h1>
      ${e?u`
              <p>${e.groupId} 组 · ${e.date}</p>
              <p class="small text-secondary">
                发布时间：${new Date(e.publishedAt).toLocaleString("zh-CN")}
              </p>
              <div class="table-responsive">
                <table class="table table-bordered align-middle">
                  <thead>
                    <tr>
                      <th>航班</th>
                      <th>岗位</th>
                      <th>人员</th>
                      <th>开始</th>
                      <th>结束</th>
                      <th>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${e.rows.map(t=>u`<tr>
                  <td>${t.flightNo}</td>
                  <td>${t.position}</td>
                  <td class=${t.status==="unfilled"?"text-danger":""}>
                    ${t.staffName||"待补位"}
                  </td>
                  <td>${t.startTime}</td>
                  <td>${t.endTime}</td>
                  <td>${D(t.remark)}</td>
                </tr>`)}
                  </tbody>
                </table>
              </div>
              <p class="small text-secondary">
                此页只展示已发布版本。班表调整后，请重新打开或刷新本页查看最新发布。
              </p>
            `:u`<p role="status">${this.message}</p>`}
    </main>`}}customElements.define("autoschedule-public-schedule",U);const G=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;function H(h,e,t,o={}){const i=o.location??window.location,n=new URLSearchParams(i.hash.slice(1)).get("schedule");let a=!1;if(n!==null){const r=new U;return h.replaceChildren(r),G.test(n)?e.readPublication(n).then(c=>{a||(r.schedule=c,c||(r.message="未找到已发布班表，请核对查看链接。"))}).catch(()=>{a||(r.message="班表暂时无法读取，请检查网络或稍后刷新。")}):r.message="查看链接不完整，请向管理员索取有效链接。",{dispose:()=>{a=!0,r.remove()}}}const f=new R,v=document.createElement("div");h.replaceChildren(f,v);let s=null,b=null,p=0,k=!1,$=null,m={phase:"loading",busy:!0,message:"正在验证登录与读取云端数据…",dirty:!1,version:0,conflict:!1,canImport:!1,cacheWarning:"",shareUrl:""};const l=(r={})=>{a||(m={...m,...r},s&&(m={...m,dirty:s.hasUnsavedChanges,version:s.cloudVersion,conflict:s.recoveryConflict,cacheWarning:s.cacheWarning,canImport:s.cloudVersion===0}),v.inert=m.busy||m.conflict,v.hidden=m.conflict,f.state=m)},C=()=>{b?.dispose(),s?.dispose(),b=null,s=null,v.replaceChildren()},S=async()=>{const r=++p;C(),l({phase:"loading",busy:!0,message:"正在验证登录与读取云端数据…",shareUrl:""});try{const c=await e.currentUser();if(a||r!==p)return;if(!c){l({phase:"login",busy:!1,message:"",dirty:!1,conflict:!1,cacheWarning:""});return}const d=await e.load();if(a||r!==p)return;$=(o.persistence??F)(t,c),s=new _(e,d,$.recovery);const g=s;g.onChange=()=>l(),b=(o.mountEditor??q)(v,{store:g.store,cloud:!0,preferences:$.preferences,shouldWarnOnExit:()=>g.hasUnsavedChanges}),l({phase:"editor",busy:!1,message:d.version===0?"云端还没有数据。可首次迁移本机资料，或在工作台配置后保存到云端。":"已读取云端数据。本机未上传的同版本修改会作为恢复内容保留。"})}catch(c){!a&&r===p&&l({phase:"error",busy:!1,message:c instanceof Error?c.message:"云端连接失败，未打开编辑页面。"})}},E=o.confirm??globalThis.confirm,L=o.download??(r=>M(new Blob([r],{type:"application/json"}),"排班云端恢复副本.json")),N=async r=>{if(k||a)return;k=!0;const c=s;l({busy:!0,message:"正在处理…"});try{if(r.type==="login")await e.signIn(r.email,r.password),await S();else if(r.type==="retry")await S();else if(r.type==="logout"&&!s)await e.signOut(),await S();else if(s){if(!b?.canTransferWorkspace())throw new Error("请先结束排班计算，或保存/取消历史编辑，再进行云端操作。");if(r.type==="download")L(s.recoveryJson()),l({message:"已生成恢复副本，请妥善保管；此文件包含内部配置与历史，不是公开班表。"});else switch(r.type){case"save":if(await s.save(),s!==c)return;l({message:"已保存到云端。公开班表仍需单独发布。"});break;case"publish":{const d=await s.publish();if(s!==c)return;const g=new URL(i.href);g.hash=`schedule=${d.token}`,l({shareUrl:g.href,message:`已发布 ${d.snapshot.groupId} 组 ${d.snapshot.date} 班表。`});break}case"import-local":if(E("只把当前浏览器的完整两组资料带入编辑区，不立即上传。确认后请核对并点击保存到云端；原本地资料保留。")){const d=$?.loadLocalModel();if(!d)throw new Error("当前浏览器没有旧本地数据，可通过现有Excel导入入口恢复配置。");s.importLocal(d),l({message:"本机资料已带入编辑区，请核对两组内容后保存到云端。"})}break;case"discard":E("确认已下载需要保留的恢复副本？继续会放弃本机旧副本，使用当前已读取的云端数据。")&&s.discardRecovery();break;case"restore":{const d=await z(r.file);if(s!==c)return;E("用此恢复副本替换当前编辑区的两组资料？不会立即改写云端，确认后请核对并重新保存。")&&(s.restoreRecovery(d),l({message:"恢复副本已带入编辑区，尚未上传；核对后请保存到云端。"}));break}case"logout":if(s.hasUnsavedChanges&&!E("还有修改未上传。退出前将保留本机恢复副本，换电脑仍无法读取这些修改。确认退出？"))break;s.recoveryConflict||s.stash(),await e.signOut(),++p,C(),l({phase:"login",dirty:!1,conflict:!1,canImport:!1,cacheWarning:"",shareUrl:"",message:"已退出当前设备。"});break}}}catch(d){(!c||s===c)&&l({message:d instanceof Error?d.message:"操作未成功，请重试。"})}finally{k=!1,l({busy:!1})}},x=r=>{N(r.detail)};f.addEventListener("cloud-command",x);const A=e.onSignedOut(()=>{queueMicrotask(()=>{if(!a){++p;try{s&&!s.recoveryConflict&&b?.canTransferWorkspace()&&s.stash()}catch{}C(),l({phase:"login",busy:!1,dirty:!1,conflict:!1,canImport:!1,cacheWarning:"",shareUrl:"",message:"登录已结束，请重新登录。"})}})});return l(),S(),{dispose:()=>{++p;try{s&&!s.recoveryConflict&&b?.canTransferWorkspace()&&s.stash()}catch{}a=!0,A(),f.removeEventListener("cloud-command",x),C(),f.remove()}}}export{H as mountCloudApplication};
//# sourceMappingURL=cloud-application-DKEobWab.js.map
