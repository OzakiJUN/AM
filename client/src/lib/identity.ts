// "Me" on this device: the username and password I use on my servers, so
// joining another server or logging in again needs no typing (docs/design.md
// §7, 资料同步). This device stands for its owner: there is no switching
// between people. The username is in localStorage; the password is kept by
// the operating system (Windows Credential Manager), never in localStorage.
import { create } from 'zustand';
import { secretDelete, secretGet, secretSet } from './transport';

const KEY = 'am-identity';
const SECRET = 'password';

interface Identity {
  username: string;
  /** A password is saved in the system's credential store. */
  hasPassword: boolean;
}

function load(): Identity {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Identity | null;
    return { username: v?.username ?? '', hasPassword: !!v?.hasPassword };
  } catch {
    return { username: '', hasPassword: false };
  }
}

export const useIdentity = create<Identity>(load);

function save(v: Identity) {
  useIdentity.setState(v);
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}

/** The saved password, or null (none saved, or the credential store said no). */
export async function savedPassword(): Promise<string | null> {
  if (!useIdentity.getState().hasPassword) return null;
  try {
    return await secretGet(SECRET);
  } catch {
    return null;
  }
}

/**
 * Remembers a login that worked, unless one is saved already (the first one
 * stays until it is forgotten in 账号设置).
 */
export async function rememberLogin(username: string, password: string) {
  if (useIdentity.getState().username) return;
  let hasPassword = false;
  try {
    await secretSet(SECRET, password);
    hasPassword = true;
  } catch {
    /* no credential store on this system: only the username is kept */
  }
  save({ username, hasPassword });
}

export async function forgetLogin() {
  try {
    await secretDelete(SECRET);
  } catch {
    /* nothing saved */
  }
  save({ username: '', hasPassword: false });
}
