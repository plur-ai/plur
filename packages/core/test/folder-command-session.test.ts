import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderAsk, setFolderEntry, FolderMapError } from '../src/index.js'
const dirs: string[]=[]
const temp=()=>{const p=realpathSync(mkdtempSync(join(tmpdir(),'plur-command-session-')));dirs.push(p);return p}
afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true})})
describe('session-bound commands without a host shell-session hook',()=>{
 it('prints the explicit session and keeps the nonce binding enforced',()=>{
  const root=temp(),dir=temp()
  const question=folderAsk({root,dir,sessionId:'ses_v2',policy:{mode:'ask',source:'default',remoteAllowed:false},claim:()=>true,bindSession:true,commandSession:true} as any)!
  expect(question.answers.length).toBeGreaterThan(0)
  for(const answer of question.answers)expect(answer.command).toContain('--session ses_v2')
  const yes=question.answers.find(a=>a.command.includes('--on'))!
  const nonce=/--nonce (\S+)/.exec(yes.command)![1]
  expect(()=>setFolderEntry(root,dir,{mode:'on'},{configuredScopes:[],nonce,session:'another'})).toThrow(FolderMapError)
  expect(()=>setFolderEntry(root,dir,{mode:'on'},{configuredScopes:[],nonce,session:'ses_v2'})).not.toThrow()
 })
 it('refuses unsafe session IDs before issuing usable commands',()=>{
  const q=folderAsk({root:temp(),dir:temp(),sessionId:'session\ncommand',policy:{mode:'ask',source:'default',remoteAllowed:false},claim:()=>true,bindSession:true,commandSession:true} as any)!
  expect(q.answers).toEqual([])
  expect(q.nonces).toEqual([])
 })
})
