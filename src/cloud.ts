// Supabase auth (email magic link + fixed admin accounts) and cloud design storage.
import { createClient, type Session } from '@supabase/supabase-js';
import { ADMIN_DOMAIN, ADMIN_USERS, SUPABASE_KEY, SUPABASE_URL } from './config';
import type { Design, Settings } from './types';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const isAdminSession = (s: Session | null) => s?.user?.app_metadata?.role === 'admin';
export const displayName = (s: Session | null) => {
  if (!s) return '';
  const u = s.user.user_metadata?.username as string | undefined;
  return u ?? s.user.email ?? 'user';
};

/** Admin usernames are NOT case sensitive: "StellarX1" == "stellarx1". */
export async function adminLogin(username: string, password: string) {
  const u = username.trim().toLowerCase();
  if (!ADMIN_USERS.includes(u)) throw new Error('Unknown admin username.');
  const { data, error } = await supabase.auth.signInWithPassword({ email: `${u}@${ADMIN_DOMAIN}`, password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong admin password.' : error.message);
  return data.session;
}

export async function sendMagicLink(email: string) {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Enter a valid email address.');
  if (e.endsWith(`@${ADMIN_DOMAIN}`)) throw new Error('That address is reserved for admin accounts.');
  const redirect = `${location.origin}${location.pathname}`;
  const { error } = await supabase.auth.signInWithOtp({ email: e, options: { emailRedirectTo: redirect, shouldCreateUser: true } });
  if (error) throw new Error(error.message);
  return e;
}

export const signOut = () => supabase.auth.signOut();

export interface CloudDesign { id: string; owner: string; name: string; design: Design; settings: Partial<Settings>; updated_at: string }

export async function saveCloudDesign(design: Design, settings: Settings, id?: string): Promise<string> {
  const row = { name: design.name, design, settings };
  if (id) {
    const { error } = await supabase.from('designs').update(row).eq('id', id);
    if (error) throw new Error(error.message);
    return id;
  }
  const { data, error } = await supabase.from('designs').insert(row).select('id').single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

export async function listCloudDesigns(): Promise<CloudDesign[]> {
  const { data, error } = await supabase.from('designs').select('*').order('updated_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as CloudDesign[];
}

export async function deleteCloudDesign(id: string) {
  const { error } = await supabase.from('designs').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
