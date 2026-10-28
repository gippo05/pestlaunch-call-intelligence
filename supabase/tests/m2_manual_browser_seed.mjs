// Disposable localhost-only manual browser QA identity seed. Never use hosted credentials.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
const raw=execFileSync("supabase",["status","-o","env"],{encoding:"utf8"});
const env=Object.fromEntries(raw.split(/\r?\n/).filter(s=>/^[A-Z_]+=/.test(s)).map(s=>{
const i=s.indexOf("=");return [s.slice(0,i),s.slice(i+1).replace(/^["']|["']$/g,"")];
}));
if(env.API_URL!=="http://127.0.0.1:54321"||!env.SECRET_KEY?.startsWith("sb_secret_")){
 throw new Error("ISOLATED_LOCAL_ONLY");
}
const admin=createClient(env.API_URL,env.SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const userEmail="m2-manual-"+randomUUID()+"@example.test";
const userPassword="LocalOnly-"+randomUUID()+"-Aa9!";
const {data,error}=await admin.auth.admin.createUser({email:userEmail,password:userPassword,email_confirm:true});
if(error||!data?.user?.id)throw new Error("LOCAL_USER_CREATION_FAILED:"+(error?.code||"unknown"));
const userId=data.user.id, workspaceId=randomUUID();
try {
const w=await admin.from("workspaces").insert({id:workspaceId,name:"M2 Manual Browser QA"});
if(w.error)throw new Error("WORKSPACE_CREATE_FAILED:"+w.error.code);
const m=await admin.from("workspace_members").insert({workspace_id:workspaceId,user_id:userId,role:"owner"});
if(m.error)throw new Error("MEMBERSHIP_CREATE_FAILED:"+m.error.code);
console.log("LOCAL_TEST_EMAIL="+userEmail);
console.log("LOCAL_TEST_PASSWORD="+userPassword);
console.log("LOCAL_TEST_WORKSPACE_ID="+workspaceId);
console.log("LOCAL_ONLY_CREDENTIALS_CREATED; NEVER USE ON HOSTED URL");
} catch(e) {
 await admin.from("workspaces").delete().eq("id",workspaceId);
 await admin.auth.admin.deleteUser(userId);
 throw e;
}
