const s="emu86-debug-v1";function o(a=null,u){let e=null;try{e=new BroadcastChannel(s)}catch{e=null}let n=null,c=null;const l=t=>{try{e?.postMessage({dbg:"trace",octet:n,name:c,pc:a,text:t})}catch{}};return l.setIdentity=(t,r)=>{n=t,c=r},l}export{s as D,o as c};
//# sourceMappingURL=debug-log-_skieu7N.js.map
