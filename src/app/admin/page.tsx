'use client';

import React, { useEffect, useState } from 'react';

interface Space {
 id: string;
 title: string;
 description: string;
 price_per_month: number;
 unlock_fee: number;
 neighborhood: string;
 contact_name: string;
 contact_phone: string;
 status: string;
 created_at: string;
 space_images?: { image_path: string }[];
}

interface Stats {
 totalSpaces: number;
 publishedCount: number;
 archivedCount: number;
 ordersCount: number;
 completedOrdersCount: number;
 totalRevenueETB: number;
 usersCount: number;
}

interface AdminUser {
 id: string;
 telegram_id: number;
 full_name: string;
 first_name?: string;
 last_name?: string;
 username?: string | null;
 phone_number?: string | null;
 gender?: string | null;
 fayda_id_number?: string | null;
 fayda_status: 'verified' | 'pending' | 'unverified';
 fayda_verified_at?: string | null;
 fayda_dob?: string | null;
 fayda_metadata?: any;
 verification_method?: string;
 role: string;
 display_code?: string | null;
 profile_status?: string | null;
 locations?: string[];
 budget_min?: number;
 budget_max?: number;
 created_at: string;
}

export default function AdminPage() {
 const [stats, setStats] = useState<Stats | null>(null);
 const [spaces, setSpaces] = useState<Space[]>([]);
 const [ordersList, setOrdersList] = useState<any[]>([]);
 const [loading, setLoading] = useState(true);
 const [activeTab, setActiveTab] = useState<'channel' | 'custom' | 'orders' | 'users' | 'register_roommate'>('channel');
 const [actionStatus, setActionStatus] = useState<string | null>(null);
 const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'unauthenticated'>('checking');
 const [passcode, setPasscode] = useState('');
 const [passcodeEnabled, setPasscodeEnabled] = useState(false);
 const [authError, setAuthError] = useState<string | null>(null);
 const [authenticating, setAuthenticating] = useState(false);

 // Fayda & Users search state
 const [usersList, setUsersList] = useState<AdminUser[]>([]);
 const [loadingUsers, setLoadingUsers] = useState(false);
 const [userSearchQuery, setUserSearchQuery] = useState('');
 const [userFilter, setUserFilter] = useState<'all' | 'verified' | 'pending' | 'unverified'>('all');

 const getAdminHeaders = (extra?: Record<string, string>): Record<string, string> => {
   const tgInit = typeof window !== 'undefined' ? (window as any).Telegram?.WebApp?.initData : '';
   return {
     ...(tgInit ? { 'x-telegram-init-data': tgInit } : {}),
     ...(extra || {}),
   };
 };

 // Custom post form state
 const [customText, setCustomText] = useState('');
 const [customPhoto, setCustomPhoto] = useState('');
 const [selectedListingId, setSelectedListingId] = useState('');
 const [postingCustom, setPostingCustom] = useState(false);

  // ── Roommate Before Room (DB Only) State ──
  const [rmFullName, setRmFullName] = useState('');
  const [rmGender, setRmGender] = useState<'Male' | 'Female'>('Female');
  const [rmPreferredGender, setRmPreferredGender] = useState<'Any' | 'Female' | 'Male'>('Any');
  const [rmLocations, setRmLocations] = useState<string[]>([]);
  const [rmBudgetMin, setRmBudgetMin] = useState('');
  const [rmBudgetMax, setRmBudgetMax] = useState('');
  const [rmBio, setRmBio] = useState('');
  const [rmAge, setRmAge] = useState('');
  const [rmOccupation, setRmOccupation] = useState('');
  const [rmPhone, setRmPhone] = useState('');
  const [rmTelegram, setRmTelegram] = useState('');
  const [rmDisplayCode, setRmDisplayCode] = useState('');
  const [submittingRm, setSubmittingRm] = useState(false);
  const [registeredRoommates, setRegisteredRoommates] = useState<any[]>([]);
  const [loadingRoommates, setLoadingRoommates] = useState(false);
  const [roommateSearch, setRoommateSearch] = useState('');

  const ADDIS_SUBCITIES = [
    'Bole', 'Mexico', 'Kazanchis', 'CMC', 'Sarbet', 'Piassa',
    '4 Kilo', 'Megenagna', 'Ayat', 'Summit', 'Lebu', 'Gerji',
    'Gotera', 'Tor Hailoch', 'Gurd Shola', 'Hayahulet', 'Jemo'
  ];

  const fetchRoommates = async (q = '') => {
    setLoadingRoommates(true);
    try {
      const res = await fetch(`/api/admin/roommates${q ? `?query=${encodeURIComponent(q)}` : ''}`, {
        headers: getAdminHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        setRegisteredRoommates(data.roommates || []);
      }
    } catch (err: any) {
      console.error('[fetchRoommates] error:', err);
    } finally {
      setLoadingRoommates(false);
    }
  };

  const handleRegisterRoommate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rmFullName.trim()) {
      alert('Please enter full name.');
      return;
    }
    if (!rmBudgetMax || Number(rmBudgetMax) <= 0) {
      alert('Please enter a valid maximum budget.');
      return;
    }
    if (!rmBio.trim()) {
      alert('Please enter a bio / lifestyle description.');
      return;
    }

    setSubmittingRm(true);
    try {
      const res = await fetch('/api/admin/roommates', {
        method: 'POST',
        headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          fullName: rmFullName,
          gender: rmGender,
          preferredGender: rmPreferredGender,
          locations: rmLocations,
          budgetMin: Number(rmBudgetMin) || 0,
          budgetMax: Number(rmBudgetMax),
          bio: rmBio,
          age: rmAge ? Number(rmAge) : undefined,
          occupation: rmOccupation || undefined,
          phone: rmPhone || undefined,
          telegramHandle: rmTelegram || undefined,
          displayCode: rmDisplayCode || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setActionStatus(`✅ Roommate ${data.displayCode} successfully registered to database! Ready for matchmaker search.`);
        // Reset form fields
        setRmFullName('');
        setRmBudgetMin('');
        setRmBudgetMax('');
        setRmBio('');
        setRmAge('');
        setRmOccupation('');
        setRmPhone('');
        setRmTelegram('');
        setRmDisplayCode('');
        setRmLocations([]);
        fetchRoommates();
      } else {
        setActionStatus(`❌ Error: ${data.error}`);
      }
    } catch (err: any) {
      setActionStatus(`❌ Error: ${err.message}`);
    } finally {
      setSubmittingRm(false);
    }
  };

  const toggleSubCity = (subcity: string) => {
    setRmLocations((prev) =>
      prev.includes(subcity) ? prev.filter((s) => s !== subcity) : [...prev, subcity]
    );
  };

 const fetchUsers = async (search = '') => {
 setLoadingUsers(true);
 try {
 const q = encodeURIComponent(search.trim());
 const res = await fetch(`/api/admin/users${q ? `?query=${q}` : ''}`, {
 headers: getAdminHeaders(),
 });
 const data = await res.json();
 if (data.success) {
 setUsersList(data.users || []);
 }
 } catch (err) {
 console.error('Failed to load users:', err);
 } finally {
 setLoadingUsers(false);
 }
 };

 const fetchAdminData = async () => {
 setLoading(true);
 try {
 const res = await fetch('/api/admin/channel', {
 headers: getAdminHeaders(),
 });
 const data = await res.json();
 if (data.success) {
 setStats(data.stats);
 setSpaces(data.spaces);
 setOrdersList(data.orders || []);
 }
 } catch (err) {
 console.error('Failed to load admin data:', err);
 } finally {
 setLoading(false);
 }
 };

 const initAdminAuth = async () => {
   setAuthState('checking');
   try {
     const url = new URL(window.location.href);
     const urlToken = url.searchParams.get('auth_token');
     if (urlToken) {
       const res = await fetch('/api/admin/auth', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ auth_token: urlToken }),
       });
       if (res.ok) {
         url.searchParams.delete('auth_token');
         window.history.replaceState({}, '', url.toString());
         setAuthState('authenticated');
         fetchAdminData();
         return;
       }
     }

     const checkRes = await fetch('/api/admin/auth');
     const checkData = await checkRes.json();
     setPasscodeEnabled(Boolean(checkData.passcodeEnabled));
     if (checkData.authenticated) {
       setAuthState('authenticated');
       fetchAdminData();
       return;
     }

     const tgInit = (window as any).Telegram?.WebApp?.initData;
     if (tgInit) {
       const tgRes = await fetch('/api/admin/auth', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ initData: tgInit }),
       });
       if (tgRes.ok) {
         setAuthState('authenticated');
         fetchAdminData();
         return;
       }
     }

     setAuthState('unauthenticated');
   } catch {
     setAuthState('unauthenticated');
   }
 };

 const handlePasscodeLogin = async (e: React.FormEvent) => {
   e.preventDefault();
   setAuthenticating(true);
   setAuthError(null);
   try {
     const res = await fetch('/api/admin/auth', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ passcode }),
     });
     const data = await res.json();
     if (res.ok && data.success) {
       setAuthState('authenticated');
       setPasscode('');
       fetchAdminData();
     } else {
       setAuthError(data.error || 'Unauthorized passcode');
     }
   } catch {
     setAuthError('Authentication request failed.');
   } finally {
     setAuthenticating(false);
   }
 };

 const handleLogout = async () => {
   await fetch('/api/admin/auth', { method: 'DELETE' });
   setAuthState('unauthenticated');
   setStats(null);
   setSpaces([]);
   setUsersList([]);
 };

 useEffect(() => {
 initAdminAuth();
 }, []);

 const handleBroadcast = async (listingId: string) => {
 setActionStatus(` Post to channel in progress for listing: ${listingId}...`);
 try {
 const res = await fetch('/api/admin/channel', {
 method: 'POST',
 headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
 body: JSON.stringify({ action: 'broadcast', listingId }),
 });
 const data = await res.json();
 if (data.success) {
 setActionStatus(` Post successfully published to Telegram channel!`);
 fetchAdminData();
 } else {
 setActionStatus(` Post failed: ${data.message || data.error}`);
 }
 } catch (err: any) {
 setActionStatus(` Error: ${err.message}`);
 }
 };

 const handleDeletePost = async (listingId: string) => {
 if (!confirm('Archive this listing and remove its Telegram channel post?')) {
 return;
 }
 setActionStatus(` Archiving space listing: ${listingId}...`);
 try {
 const res = await fetch('/api/admin/channel', {
 method: 'POST',
 headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
 body: JSON.stringify({ action: 'delete_post', listingId }),
 });
 const data = await res.json();
 if (data.success) {
 setActionStatus(` Space archived and channel post removed!`);
 fetchAdminData();
 } else {
 setActionStatus(` Archive failed: ${data.error || data.message}`);
 }
 } catch (err: any) {
 setActionStatus(` Error: ${err.message}`);
 }
 };

 const handleDeleteDb = async (listingId: string) => {
 if (!confirm('Permanently delete this space and all associated images/orders from the database? This cannot be undone.')) {
 return;
 }
 setActionStatus(` Permanently deleting space listing: ${listingId}...`);
 try {
 const res = await fetch('/api/admin/channel', {
 method: 'POST',
 headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
 body: JSON.stringify({ action: 'delete_space_db', listingId }),
 });
 const data = await res.json();
 if (data.success) {
 setActionStatus(` Space permanently deleted from database.`);
 fetchAdminData();
 } else {
 setActionStatus(` DB delete failed: ${data.error || data.message}`);
 }
 } catch (err: any) {
 setActionStatus(` Error: ${err.message}`);
 }
 };

 const handleCustomPost = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!customText.trim()) return;

 setPostingCustom(true);
 setActionStatus(' Publishing custom post to channel...');

 try {
 const res = await fetch('/api/admin/channel', {
 method: 'POST',
 headers: getAdminHeaders({ 'Content-Type': 'application/json' }),
 body: JSON.stringify({
 action: 'custom_post',
 text: customText,
 photoUrl: customPhoto || undefined,
 listingId: selectedListingId || undefined,
 }),
 });

 const data = await res.json();
 if (data.success) {
 setActionStatus(' Custom announcement published to Telegram channel with Order in Bot button!');
 setCustomText('');
 setCustomPhoto('');
 setSelectedListingId('');
 } else {
 setActionStatus(` Custom post failed: ${data.message || data.error}`);
 }
 } catch (err: any) {
 setActionStatus(` Error: ${err.message}`);
 } finally {
 setPostingCustom(false);
 }
 };

 const filteredUsers = usersList.filter((u) => {
 if (userFilter === 'verified') return u.fayda_status === 'verified';
 if (userFilter === 'pending') return u.fayda_status === 'pending';
 if (userFilter === 'unverified') return u.fayda_status === 'unverified';
 return true;
 });

 if (authState === 'checking') {
   return (
     <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
       <div className="text-center space-y-3">
         <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto" />
         <p className="text-sm text-slate-400">Verifying SpaceMatch Admin session...</p>
       </div>
     </main>
   );
 }

 if (authState === 'unauthenticated') {
   return (
     <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
       <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5 shadow-2xl">
         <div>
           <h1 className="text-xl font-bold text-white">SpaceMatch Admin Portal</h1>
           <p className="text-xs text-slate-400 mt-1">
             Restricted Access / የተፈቀደላቸው አስተዳዳሪዎች ብቻ
           </p>
         </div>
         <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 space-y-2 leading-relaxed">
           <p className="font-semibold text-emerald-400">Sign in via Telegram Bot (Recommended):</p>
           <p>Open <b>@Spacematchaddis_bot</b> as a verified Super Admin and send <code>/admin</code>, then tap the <b>Open Web Admin Portal</b> button.</p>
         </div>
         {passcodeEnabled && (
           <form onSubmit={handlePasscodeLogin} className="space-y-3">
             <div>
               <label className="block text-xs text-slate-400 mb-1">Admin Passcode</label>
               <input
                 type="password"
                 value={passcode}
                 onChange={(e) => setPasscode(e.target.value)}
                 placeholder="Enter admin passcode..."
                 className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-emerald-500"
               />
             </div>
             {authError && <p className="text-xs text-rose-400">{authError}</p>}
             <button
               type="submit"
               disabled={authenticating || !passcode.trim()}
               className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold transition"
             >
               {authenticating ? 'Signing in...' : 'Sign In'}
             </button>
           </form>
         )}
       </div>
     </main>
   );
 }

 return (
 <main className="min-h-screen bg-slate-950 text-slate-100 font-sans pb-16">
 {/* Top Navigation */}
 <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
 <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
 <div className="flex items-center gap-3">
 <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center font-bold text-lg">
 SM
 </div>
 <div>
 <h1 className="font-bold text-lg text-white">SpaceMatch Admin Portal</h1>
 <p className="text-xs text-slate-400">ስማርት የቴሌግራም ቻነልና የክፍሎች አስተዳዳሪ</p>
 </div>
 </div>
 <div className="flex items-center gap-2">
 <button
 onClick={fetchAdminData}
 className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition flex items-center gap-1.5"
 >
 Refresh Data
 </button>
 <button
 onClick={handleLogout}
 className="px-3 py-1.5 text-xs bg-rose-950/60 hover:bg-rose-900/70 text-rose-300 rounded-lg border border-rose-800/50 transition"
 >
 Sign Out
 </button>
 </div>
 </div>
 </header>

 <div className="max-w-6xl mx-auto px-4 pt-6 space-y-6">
 {/* Status Alert Banner */}
 {actionStatus && (
 <div className="p-4 rounded-xl bg-slate-900 border border-emerald-500/30 text-emerald-400 text-sm flex items-center justify-between shadow-lg">
 <span>{actionStatus}</span>
 <button
 onClick={() => setActionStatus(null)}
 aria-label="Dismiss alert"
 className="text-xs text-slate-400 hover:text-white px-1.5"
 >
 ✕
 </button>
 </div>
 )}

 {/* Overview Analytics Cards */}
 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
 <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
 <p className="text-xs text-slate-400 font-medium">Published Rooms</p>
 <p className="text-2xl font-bold text-emerald-400 mt-1">
 {loading ? '...' : stats?.publishedCount || 0}
 </p>
 <span className="text-[10px] text-slate-500">Live in Channel & App</span>
 </div>

 <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
 <p className="text-xs text-slate-400 font-medium">Completed Orders</p>
 <p className="text-2xl font-bold text-blue-400 mt-1">
 {loading ? '...' : stats?.completedOrdersCount || 0}
 </p>
 <span className="text-[10px] text-slate-500">Unlocked Contact Cards</span>
 </div>

 <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
 <p className="text-xs text-slate-400 font-medium">Telebirr Revenue</p>
 <p className="text-2xl font-bold text-amber-400 mt-1">
 {loading ? '...' : `${stats?.totalRevenueETB || 0} ETB`}
 </p>
 <span className="text-[10px] text-slate-500">Total Unlock Fees</span>
 </div>

 <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
 <p className="text-xs text-slate-400 font-medium">Registered Users</p>
 <p className="text-2xl font-bold text-purple-400 mt-1">
 {loading ? '...' : stats?.usersCount || 0}
 </p>
 <span className="text-[10px] text-slate-500">Bot & App Renter Accounts</span>
 </div>
 </div>

 {/* Tab Navigation */}
 <div className="flex overflow-x-auto border-b border-slate-800 gap-6 text-sm font-medium whitespace-nowrap">
 <button
 onClick={() => setActiveTab('channel')}
 className={`pb-3 border-b-2 transition ${
 activeTab === 'channel'
 ? 'border-emerald-500 text-emerald-400 font-semibold'
 : 'border-transparent text-slate-400 hover:text-slate-200'
 }`}
 >
 Channel Posts & Listings ({spaces.filter((s) => s.status === 'published').length})
 </button>
 <button
 onClick={() => setActiveTab('custom')}
 className={`pb-3 border-b-2 transition ${
 activeTab === 'custom'
 ? 'border-emerald-500 text-emerald-400 font-semibold'
 : 'border-transparent text-slate-400 hover:text-slate-200'
 }`}
 >
 Post Directly to Channel
 </button>
 <button
 onClick={() => setActiveTab('orders')}
 className={`pb-3 border-b-2 transition ${
 activeTab === 'orders'
 ? 'border-emerald-500 text-emerald-400 font-semibold'
 : 'border-transparent text-slate-400 hover:text-slate-200'
 }`}
 >
 Orders & Payments ({ordersList.length})
 </button>
 <button
 onClick={() => {
 setActiveTab('register_roommate');
 if (registeredRoommates.length === 0) fetchRoommates();
 }}
 className={`pb-3 border-b-2 transition ${
 activeTab === 'register_roommate'
 ? 'border-emerald-500 text-emerald-400 font-semibold'
 : 'border-transparent text-slate-400 hover:text-slate-200'
 }`}
 >
 Register Roommate (DB)
 </button>
 <button
 onClick={() => {
 setActiveTab('users');
 if (usersList.length === 0) fetchUsers();
 }}
 className={`pb-3 border-b-2 transition ${
 activeTab === 'users'
 ? 'border-emerald-500 text-emerald-400 font-semibold'
 : 'border-transparent text-slate-400 hover:text-slate-200'
 }`}
 >
 Fayda & Users Directory
 </button>
 </div>

 {/* TAB 1: CHANNEL POSTS MANAGER */}
 {activeTab === 'channel' && (
 <div className="space-y-4">
 <div className="flex items-center justify-between">
 <h2 className="text-base font-semibold text-slate-200">
 Active Channel Listings & Controls
 </h2>
 <span className="text-xs text-slate-400">
 Direct controls to post or delete listings from Telegram channel
 </span>
 </div>

 {loading ? (
 <div className="py-12 text-center text-slate-500">Loading listings...</div>
 ) : spaces.length === 0 ? (
 <div className="py-12 text-center text-slate-500 bg-slate-900/50 rounded-2xl border border-slate-800">
 No room listings found.
 </div>
 ) : (
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 {spaces.map((space) => {
 const coverPhoto =
 space.space_images && space.space_images.length > 0
 ? space.space_images[0].image_path
 : 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=600&q=80';

 const isPublished = space.status === 'published';

 return (
 <div
 key={space.id}
 className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col justify-between"
 >
 <div className="p-4 space-y-3">
 <div className="flex items-start justify-between gap-3">
 <img
 src={coverPhoto}
 alt={space.title}
 className="w-20 h-20 rounded-xl object-cover border border-slate-800"
 />
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2">
 <span
 className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
 isPublished
 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
 : 'bg-slate-800 text-slate-400'
 }`}
 >
 {space.status.toUpperCase()}
 </span>
 <span className="text-xs text-slate-400"> {space.neighborhood}</span>
 </div>
 <h3 className="font-bold text-sm text-slate-100 truncate mt-1">
 {space.title}
 </h3>
 <p className="text-xs text-emerald-400 font-semibold mt-0.5">
 {Number(space.price_per_month).toLocaleString()} ETB/month • Fee: {space.unlock_fee} ETB
 </p>
 <p className="text-xs text-slate-400 mt-1">
 {space.contact_name} ({space.contact_phone})
 </p>
 </div>
 </div>
 <p className="text-xs text-slate-400 line-clamp-2">{space.description}</p>
 </div>

 <div className="bg-slate-950 p-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
 <button
 onClick={() => handleBroadcast(space.id)}
 className="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl transition flex items-center justify-center gap-1.5"
 >
 Post to Channel
 </button>
 <button
 onClick={() => handleDeletePost(space.id)}
 className="py-2 px-3 bg-amber-950/80 hover:bg-amber-900 text-amber-300 border border-amber-800/50 font-medium text-xs rounded-xl transition flex items-center justify-center gap-1.5"
 >
 Archive
 </button>
 <button
 onClick={() => handleDeleteDb(space.id)}
 className="py-2 px-3 bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800/50 font-medium text-xs rounded-xl transition flex items-center justify-center gap-1.5"
 >
 Delete DB
 </button>
 </div>
 </div>
 );
 })}
 </div>
 )}
 </div>
 )}

 {/* TAB 2: CUSTOM DIRECT CHANNEL POST BUILDER */}
 {activeTab === 'custom' && (
 <div className="max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
 <div>
 <h2 className="text-base font-semibold text-slate-100">
 Post Custom Announcement to Channel
 </h2>
 <p className="text-xs text-slate-400 mt-1">
 Compose a custom text or photo post. The system will automatically attach the{' '}
 <span className="text-emerald-400 font-semibold">" በቦት እዘዝ (Order in Bot)"</span>{' '}
 inline button to your post in the channel.
 </p>
 </div>

 <form onSubmit={handleCustomPost} className="space-y-4">
 <div>
 <label className="block text-xs font-medium text-slate-300 mb-1">
 Post Caption / Text (HTML formatted)
 </label>
 <textarea
 rows={5}
 value={customText}
 onChange={(e) => setCustomText(e.target.value)}
 placeholder=" አዲስ የሚከራይ ክፍል በቦሌ አትላስ...\n ወርሃዊ ኪራይ፡ 15,000 ብር"
 className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
 required
 />
 </div>

 <div>
 <label className="block text-xs font-medium text-slate-300 mb-1">
 Photo URL (Optional)
 </label>
 <input
 type="url"
 value={customPhoto}
 onChange={(e) => setCustomPhoto(e.target.value)}
 placeholder="https://images.unsplash.com/photo-1522708323590-d24dbb6b0267"
 className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
 />
 </div>

 <div>
 <label className="block text-xs font-medium text-slate-300 mb-1">
 Link Order Button to Specific Room (Optional)
 </label>
 <select
 value={selectedListingId}
 onChange={(e) => setSelectedListingId(e.target.value)}
 className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
 >
 <option value="">-- General Order Menu (Default) --</option>
 {spaces.map((s) => (
 <option key={s.id} value={s.id}>
 {s.title} ({s.neighborhood}) - {s.price_per_month} ETB
 </option>
 ))}
 </select>
 </div>

 <button
 type="submit"
 disabled={postingCustom}
 className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-sm rounded-xl transition flex items-center justify-center gap-2"
 >
 {postingCustom ? 'Publishing...' : ' Publish Directly to Telegram Channel'}
 </button>
 </form>
 </div>
 )}

 {/* TAB 3: FAYDA & USERS SEARCH DIRECTORY */}
 {activeTab === 'users' && (
 <div className="space-y-5">
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
 <div>
 <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
 <span></span> Fayda Residents & Identity Search
 </h2>
 <p className="text-xs text-slate-400 mt-0.5">
 Search registered residents by name, username, or 16-digit Fayda FAN to view complete KYC & demographic records.
 </p>
 </div>

 {/* Status Filter Chips */}
 <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 p-1 rounded-xl text-xs">
 {(['all', 'verified', 'pending', 'unverified'] as const).map((f) => (
 <button
 key={f}
 onClick={() => setUserFilter(f)}
 className={`px-3 py-1.5 rounded-lg transition capitalize font-medium ${
 userFilter === f
 ? 'bg-emerald-600 text-white'
 : 'text-slate-400 hover:text-slate-200'
 }`}
 >
 {f === 'all' ? 'All Residents' : f === 'verified' ? 'Verified' : f === 'pending' ? 'Pending' : 'Unverified'}
 </button>
 ))}
 </div>
 </div>

 {/* Search Input Bar */}
 <form
 onSubmit={(e) => {
 e.preventDefault();
 fetchUsers(userSearchQuery);
 }}
 className="flex gap-2"
 >
 <div className="relative flex-1">
 <input
 type="text"
 value={userSearchQuery}
 onChange={(e) => setUserSearchQuery(e.target.value)}
 placeholder=" Search resident by name (e.g. Tsehay, Biruk), @username, or Fayda FAN..."
 className="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
 />
 {userSearchQuery && (
 <button
 type="button"
 onClick={() => {
 setUserSearchQuery('');
 fetchUsers('');
 }}
 className="absolute right-3 top-3 text-xs text-slate-400 hover:text-white"
 >
 Clear
 </button>
 )}
 </div>
 <button
 type="submit"
 disabled={loadingUsers}
 className="px-5 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm rounded-xl transition flex items-center gap-1.5"
 >
 {loadingUsers ? 'Searching...' : 'Search'}
 </button>
 </form>

 {/* Users Cards / List */}
 {loadingUsers ? (
 <div className="py-16 text-center text-slate-500">Searching user directory...</div>
 ) : filteredUsers.length === 0 ? (
 <div className="py-16 text-center text-slate-500 bg-slate-900/50 rounded-2xl border border-slate-800">
 {userSearchQuery
 ? `No residents found matching "${userSearchQuery}".`
 : 'No users found in directory.'}
 </div>
 ) : (
 <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
 {filteredUsers.map((u) => {
 const isVerified = u.fayda_status === 'verified';
 const isPending = u.fayda_status === 'pending';

 return (
 <div
 key={u.id || u.telegram_id}
 className="bg-slate-900 border border-slate-800 hover:border-slate-700 transition rounded-2xl p-5 flex flex-col justify-between space-y-4"
 >
 <div className="space-y-3">
 {/* Header: Name + Badge */}
 <div className="flex items-start justify-between gap-2">
 <div>
 <div className="flex items-center gap-2">
 <h3 className="font-bold text-slate-100 text-sm">
 {u.full_name}
 </h3>
 {isVerified && (
 <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
 Fayda Verified
 </span>
 )}
 {isPending && (
 <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
 ⏳ Pending
 </span>
 )}
 {!isVerified && !isPending && (
 <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-800 text-slate-400">
 Unverified
 </span>
 )}
 </div>
 <p className="text-xs text-slate-400 mt-0.5">
 {u.username ? (
 <a
 href={`https://t.me/${u.username}`}
 target="_blank"
 rel="noopener noreferrer"
 className="text-emerald-400 hover:underline"
 >
 @{u.username}
 </a>
 ) : (
 <span>ID: {u.telegram_id}</span>
 )}
 {u.display_code && (
 <span className="ml-2 font-mono text-[11px] text-purple-400 font-semibold">
 {u.display_code}
 </span>
 )}
 </p>
 </div>

 <span className="text-[11px] font-mono px-2 py-1 rounded bg-slate-950 text-slate-400 border border-slate-800">
 {u.role}
 </span>
 </div>

 {/* Fayda Details Box */}
 <div className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3 text-xs space-y-1.5">
 <div className="flex items-center justify-between">
 <span className="text-slate-400">Fayda FAN (16-Digit):</span>
 <span className="font-mono font-bold text-slate-200 select-all">
 {u.fayda_id_number || 'None on file'}
 </span>
 </div>

 <div className="flex items-center justify-between">
 <span className="text-slate-400">Date of Birth:</span>
 <span className="text-slate-300 font-mono">
 {u.fayda_dob || 'Not captured / Pre-V4'}
 </span>
 </div>

 <div className="flex items-center justify-between">
 <span className="text-slate-400">Official Gender:</span>
 <span className="text-slate-300">
 {u.gender || 'Not specified'}
 </span>
 </div>

 <div className="flex items-center justify-between">
 <span className="text-slate-400">Verification Method:</span>
 <span className="text-slate-300 text-[11px]">
 {u.verification_method || (isVerified ? 'Fayda Verified' : 'N/A')}
 </span>
 </div>

 {u.fayda_verified_at && (
 <div className="flex items-center justify-between">
 <span className="text-slate-400">Verified On:</span>
 <span className="text-slate-400 text-[11px]">
 {new Date(u.fayda_verified_at).toLocaleDateString('en-US', {
 month: 'short',
 day: 'numeric',
 year: 'numeric',
 })}
 </span>
 </div>
 )}
 </div>

 {/* Contact & Preference Metadata */}
 <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 pt-1">
 <div>
 <span className="text-slate-500 block text-[10px]">PHONE</span>
 <span className="text-slate-300 font-mono">
 {u.phone_number || 'Not provided'}
 </span>
 </div>
 <div>
 <span className="text-slate-500 block text-[10px]">BUDGET</span>
 <span className="text-slate-300 font-mono">
 {u.budget_min || u.budget_max
 ? `${Number(u.budget_min || 0).toLocaleString()} - ${Number(u.budget_max || 0).toLocaleString()} ETB`
 : 'Negotiable'}
 </span>
 </div>
 {u.locations && u.locations.length > 0 && (
 <div className="col-span-2">
 <span className="text-slate-500 block text-[10px]">LOCATIONS</span>
 <span className="text-slate-300 truncate block">
 {u.locations.join(', ')}
 </span>
 </div>
 )}
 </div>
 </div>

 {/* Card Actions */}
 <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2">
 {u.username ? (
 <a
 href={`https://t.me/${u.username}`}
 target="_blank"
 rel="noopener noreferrer"
 className="flex-1 py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl transition text-center"
 >
 Telegram @{u.username}
 </a>
 ) : u.telegram_id ? (
 <a
 href={`tg://user?id=${u.telegram_id}`}
 className="flex-1 py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl transition text-center"
 >
 Open Chat
 </a>
 ) : null}

 {u.phone_number && (
 <a
 href={`tel:${u.phone_number}`}
 className="py-1.5 px-3 bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-800/50 text-xs font-medium rounded-xl transition"
 >
 Call
 </a>
 )}
 </div>
 </div>
 );
 })}
 </div>
 )}
 </div>
 )}

 {/* TAB: ORDERS & PAYMENTS */}
 {activeTab === 'orders' && (
 <div className="space-y-4">
 <div className="flex items-center justify-between">
 <h2 className="text-base font-semibold text-slate-200">
 Verified & Pending Orders ({ordersList.length})
 </h2>
 <button
 onClick={fetchAdminData}
 className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
 >
 Refresh
 </button>
 </div>
 <div className="overflow-x-auto bg-slate-900 border border-slate-800 rounded-2xl">
 <table className="w-full text-left text-xs text-slate-300">
 <thead className="bg-slate-950/70 text-slate-400 border-b border-slate-800 uppercase text-[10px]">
 <tr>
 <th className="py-3 px-4">Ref</th>
 <th className="py-3 px-4">Buyer TG ID</th>
 <th className="py-3 px-4">Type</th>
 <th className="py-3 px-4">Amount</th>
 <th className="py-3 px-4">Status</th>
 <th className="py-3 px-4">Date</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-800/80">
 {ordersList.length === 0 ? (
 <tr>
 <td colSpan={6} className="py-8 text-center text-slate-500">No orders recorded yet.</td>
 </tr>
 ) : (
 ordersList.slice(0, 100).map((ord) => (
 <tr key={ord.id} className="hover:bg-slate-800/40">
 <td className="py-3 px-4 font-mono text-slate-200">{ord.transaction_reference || ord.id.slice(0, 8)}</td>
 <td className="py-3 px-4 font-mono">{ord.buyer_telegram_id || ord.renter_telegram_id || 'N/A'}</td>
 <td className="py-3 px-4">{ord.order_type || ord.target_type || 'order'}</td>
 <td className="py-3 px-4 font-semibold text-emerald-400">{Number(ord.amount || 0).toLocaleString()} ETB</td>
 <td className="py-3 px-4">
 <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
 ord.payment_status === 'completed'
 ? 'bg-emerald-500/20 text-emerald-300'
 : 'bg-amber-500/20 text-amber-300'
 }`}>
 {ord.payment_status}
 </span>
 </td>
 <td className="py-3 px-4 text-slate-400">{new Date(ord.created_at).toLocaleDateString()}</td>
 </tr>
 ))
 )}
 </tbody>
 </table>
 </div>
 </div>
 )}

 {/* TAB: REGISTER ROOMMATE (DB ONLY) */}
 {activeTab === 'register_roommate' && (
 <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
 <form onSubmit={handleRegisterRoommate} className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
 <h2 className="text-base font-semibold text-slate-100">Register Concierge Roommate (DB Only)</h2>
 <div className="grid grid-cols-2 gap-3">
 <input value={rmFullName} onChange={(e) => setRmFullName(e.target.value)} placeholder="Full Name *" className="col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 <select value={rmGender} onChange={(e) => setRmGender(e.target.value as 'Male' | 'Female')} className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white">
 <option value="Female">Female</option>
 <option value="Male">Male</option>
 </select>
 <select value={rmPreferredGender} onChange={(e) => setRmPreferredGender(e.target.value as 'Any' | 'Female' | 'Male')} className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white">
 <option value="Any">Prefers Any</option>
 <option value="Female">Prefers Female</option>
 <option value="Male">Prefers Male</option>
 </select>
 <input type="number" value={rmBudgetMin} onChange={(e) => setRmBudgetMin(e.target.value)} placeholder="Budget Min (ETB)" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 <input type="number" value={rmBudgetMax} onChange={(e) => setRmBudgetMax(e.target.value)} placeholder="Budget Max (ETB) *" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 <input type="number" min="18" max="99" value={rmAge} onChange={(e) => setRmAge(e.target.value)} placeholder="Age (optional)" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 <input value={rmOccupation} onChange={(e) => setRmOccupation(e.target.value)} placeholder="Occupation / Job (optional)" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 <input value={rmPhone} onChange={(e) => setRmPhone(e.target.value)} placeholder="Phone (optional)" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 <input value={rmTelegram} onChange={(e) => setRmTelegram(e.target.value)} placeholder="Telegram @handle" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 <input value={rmDisplayCode} onChange={(e) => setRmDisplayCode(e.target.value)} placeholder="Display Code (auto if blank)" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 </div>
 <div className="flex flex-wrap gap-1.5">
 {ADDIS_SUBCITIES.map((sub) => {
 const active = rmLocations.includes(sub);
 return (
 <button
 type="button"
 key={sub}
 onClick={() => setRmLocations((prev) => active ? prev.filter((x) => x !== sub) : [...prev, sub])}
 className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border ${active ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300' : 'bg-slate-950 border-slate-800 text-slate-400'}`}
 >
 {sub}
 </button>
 );
 })}
 </div>
 <textarea value={rmBio} onChange={(e) => setRmBio(e.target.value)} rows={3} placeholder="Lifestyle Bio & Preferences *" className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white" />
 <button type="submit" disabled={submittingRm} className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50">
 {submittingRm ? 'Registering...' : 'Save Roommate to Database'}
 </button>
 </form>

 <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
 <div className="flex items-center justify-between gap-2">
 <h2 className="text-base font-semibold text-slate-100">Registered Seekers ({registeredRoommates.length})</h2>
 <div className="flex gap-2">
 <input value={roommateSearch} onChange={(e) => setRoommateSearch(e.target.value)} placeholder="Search code/name" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white" />
 <button type="button" onClick={() => fetchRoommates(roommateSearch)} className="px-3 py-1.5 rounded-xl bg-slate-800 text-xs text-white">Find</button>
 </div>
 </div>
 {loadingRoommates ? (
 <p className="text-xs text-slate-400">Loading seekers...</p>
 ) : (
 <div className="space-y-2 max-h-[480px] overflow-y-auto">
 {registeredRoommates.map((rm) => (
 <div key={rm.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs flex justify-between gap-2">
 <div>
 <p className="font-bold text-slate-100">{rm.full_name} <span className="text-emerald-400 font-mono">#{String(rm.display_code || '').replace(/^#/, '')}</span></p>
 <p className="text-slate-400">{rm.gender} · {Array.isArray(rm.locations) ? rm.locations.join(', ') : 'Addis'} · {Number(rm.budget_max || 0).toLocaleString()} ETB</p>
 </div>
 <span className="text-[10px] text-slate-400 uppercase">{rm.status}</span>
 </div>
 ))}
 </div>
 )}
 </div>
 </div>
 )}
 </div>
 </main>
 );
}
