import React, { useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, Layers, Package, FileText,
  LogOut, Menu, X, ChevronRight, Settings, Shield, Palette, Scissors, Shirt, ClipboardList, ShieldCheck, UserRound, Truck, Warehouse, Inbox, PackageCheck
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';
import { isLoomHost } from '../../utils/loomIdentity';
import { useScrollLock } from '../../utils/useScrollLock';
import { AnimatePresence, motion } from 'framer-motion';
import FlowLogo from '../FlowLogo';

export default function ProductionLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  useScrollLock(isMobileMenuOpen);

  const staffRole = user?.staffRole || '';
  const effectiveRole = staffRole || user?.role || '';
  const loom = isLoomHost();

  const navGroups = [
    {
      title: 'Overview',
      items: [
        { path: '/production', label: 'Dashboard', icon: LayoutDashboard, roles: ['admin','super_admin','owner','pm','designer','dispatch','guard','tailor','store','accounts','analysis'] },
      ],
    },
    {
      title: 'Master Data',
      items: [
        { path: '/production/staff', label: 'Staff', icon: Users, roles: ['admin','super_admin','owner'], show: can(effectiveRole as any, 'production.staff') },
        { path: '/production/karigars', label: 'Karigars', icon: Users, roles: ['admin','super_admin','owner','pm','dispatch'], show: can(effectiveRole as any, 'production.karigars') },
      ],
    },
    {
      title: 'Design Chain',
      items: [
        { path: '/production/designs', label: 'Catalogue Designs', icon: Palette, roles: ['admin','super_admin','owner','designer','pm','dispatch'], show: can(effectiveRole as any, 'production.designs') },
        { path: '/production/sample-designs', label: 'Sample Designs', icon: Scissors, roles: ['admin','super_admin','owner','designer','pm','dispatch'], show: can(effectiveRole as any, 'production.sampleDesigns') },
        { path: '/production/sample-pieces', label: 'Sample Pieces', icon: Shirt, roles: ['admin','super_admin','owner','designer','pm','dispatch'], show: can(effectiveRole as any, 'production.samplePieces') },
        { path: '/production/requests', label: 'Production Requests', icon: ClipboardList, roles: ['admin','super_admin','owner','pm','dispatch'], show: can(effectiveRole as any, 'production.requests') },
        { path: '/production/pieces', label: 'Pieces', icon: Package, roles: ['admin','super_admin','owner','pm','dispatch','guard','tailor','store'], show: can(effectiveRole as any, 'production.pieces') },
        { path: '/production/qc', label: 'Guard QC', icon: ShieldCheck, roles: ['admin','super_admin','guard','pm'], show: can(effectiveRole as any, 'production.qc') },
      ],
    },
    {
      title: 'Fabric',
      items: [
        { path: '/production/fabric', label: 'Fabric Inventory', icon: Layers, roles: ['dispatch'], show: can(effectiveRole as any, 'production.fabric') },
        { path: '/production/fabric-issues', label: 'Fabric Issues', icon: PackageCheck, roles: ['guard'], show: can(effectiveRole as any, 'production.fabric.issues') },
      ],
    },
    /* Role workspaces — these routes existed in App.tsx but had NO link
     * anywhere in the UI, so Dispatch / Tailor / Store / Owner could not
     * reach their own daily screens. Each is gated by the same can() module
     * the page itself checks, so a link is shown only when the page will
     * actually work for that role. */
    {
      title: 'Workspaces',
      items: [
        { path: '/production/dispatch', label: 'Dispatch Workspace', icon: Truck, roles: ['dispatch'], show: can(effectiveRole as any, 'production.dispatch.assignTailor') },
        { path: '/production/tailor', label: 'Tailor Workspace', icon: Scissors, roles: ['tailor'], show: can(effectiveRole as any, 'production.tailor') },
        { path: '/production/store', label: 'Store Workspace', icon: Warehouse, roles: ['store'], show: can(effectiveRole as any, 'production.store') && can(effectiveRole as any, 'production.pieces') },
        { path: '/production/tailor-requests', label: 'Tailor Requests', icon: Inbox, roles: ['owner'], show: can(effectiveRole as any, 'production.tailorRequests.review') },
      ],
    },
    // "System" links point into the separate B2C storefront app — never shown
    // on LUXARDO FLOW (Loom), which does not mount the B2C portal at all.
    ...(loom ? [] : [{
      title: 'System',
      items: [
        { path: '/admin/dashboard', label: 'Admin Portal', icon: Shield, roles: ['admin','super_admin'] },
        { path: '/backend', label: 'E-Commerce Portal', icon: Settings, roles: ['admin','super_admin','owner','dispatch','accounts','analysis'] },
      ],
    }]),
  ];

  const filteredGroups = navGroups.map(g => ({
    ...g,
    // `show` (the can() permission check) is the source of truth when an item
    // defines it; `roles` is only the fallback. The old `roles || show !== false`
    // test showed every item WITHOUT `show` (e.g. Staff) to every role — a
    // link that then silently bounced non-admins back to the Dashboard.
    items: g.items.filter(it => ((it as any).show !== undefined ? (it as any).show : it.roles.includes(effectiveRole))),
  })).filter(g => g.items.length > 0);

  const handleLogout = async () => {
    await logout();
    navigate(loom ? '/login' : '/admin/login');
  };

  return (
    <div className="h-screen bg-gray-50 flex font-sans text-black selection:bg-black selection:text-white overflow-hidden">
      {/* ── Desktop Sidebar ── */}
      <aside className="w-64 bg-white border-r border-gray-200 flex-col hidden md:flex h-screen shrink-0 overflow-hidden z-20">
        <div className="p-8 border-b border-gray-100 flex flex-col justify-center min-h-[100px] shrink-0">
          <FlowLogo size="md" />
          <p className="text-[10px] text-gray-400 uppercase tracking-widest mt-2 font-bold">Loom · Production</p>
        </div>

        {/* Its own independent vertical scroll container: min-h-0 overrides
            the flex-item default (min-height:auto), which otherwise refuses
            to let this shrink below its content height — without it, a long
            nav silently overflows past the sidebar's fixed height instead of
            scrolling internally. */}
        <nav className="flex-1 min-h-0 px-4 py-8 space-y-8 overflow-y-auto scrollbar-hide">
          {filteredGroups.map(group => (
            <div key={group.title} className="space-y-3">
              <h3 className="text-[9px] uppercase tracking-[0.2em] font-bold text-gray-400 px-4 select-none">
                {group.title}
              </h3>
              <div className="space-y-1">
                {group.items.map(item => {
                  const isActive = item.path === '/production'
                    ? location.pathname === '/production'
                    : location.pathname.startsWith(item.path);
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-all duration-200 rounded-lg group ${
                        isActive
                          ? 'bg-black text-white font-medium shadow-sm'
                          : 'text-gray-500 hover:bg-gray-50 hover:text-black'
                      }`}
                    >
                      <item.icon size={16} className={`${isActive ? 'text-white' : 'text-gray-400 group-hover:text-black'} transition-colors`} />
                      <span className="tracking-wide">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-100 bg-white shrink-0">
          <Link
            to="/production/profile"
            className="block px-4 pb-3 text-[9px] text-gray-400 uppercase tracking-widest font-bold truncate hover:text-black transition-colors"
          >
            {user?.name} · {staffRole || user?.role}
          </Link>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-4 py-3 text-sm text-gray-500 hover:bg-gray-50 hover:text-black w-full text-left transition-all duration-200 rounded-lg group"
          >
            <LogOut size={16} className="text-gray-400 group-hover:text-black transition-colors" />
            <span className="tracking-wide">Sign Out</span>
          </button>
        </div>
      </aside>

      {/* ── Mobile Sidebar Overlay ── */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="fixed inset-0 bg-black/40 z-40 md:hidden backdrop-blur-sm"
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 left-0 w-[280px] bg-white border-r border-gray-200 flex flex-col overflow-hidden z-50 md:hidden shadow-2xl"
            >
              <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white shrink-0">
                <div>
                  <FlowLogo size="sm" />
                  <p className="text-[9px] text-gray-400 uppercase tracking-widest mt-1 font-bold">Loom · Production</p>
                </div>
                <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 -mr-2 text-gray-400 hover:text-black hover:bg-gray-50 rounded-lg transition-colors">
                  <X size={20} />
                </button>
              </div>

              {/* Same min-h-0 fix as the desktop nav above — the drawer's
                  own internal scroll for content taller than the viewport. */}
              <nav className="flex-1 min-h-0 px-4 py-6 space-y-8 overflow-y-auto scrollbar-hide">
                {filteredGroups.map(group => (
                  <div key={group.title} className="space-y-2">
                    <h3 className="text-[9px] uppercase tracking-[0.2em] font-bold text-gray-400 px-4">{group.title}</h3>
                    <div className="space-y-1">
                      {group.items.map(item => {
                        const isActive = item.path === '/production'
                          ? location.pathname === '/production'
                          : location.pathname.startsWith(item.path);
                        return (
                          <Link
                            key={item.path}
                            to={item.path}
                            onClick={() => setIsMobileMenuOpen(false)}
                            className={`flex items-center gap-3 px-4 py-3 text-sm transition-all duration-200 rounded-lg ${
                              isActive
                                ? 'bg-black text-white font-medium'
                                : 'text-gray-500 hover:bg-gray-50 hover:text-black'
                            }`}
                          >
                            <item.icon size={18} className={isActive ? 'text-white' : 'text-gray-400'} />
                            <span className="tracking-wide">{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </nav>

              <div className="p-4 border-t border-gray-100 bg-white shrink-0">
                <Link
                  to="/production/profile"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm text-gray-500 hover:bg-gray-50 hover:text-black w-full text-left transition-all duration-200 rounded-lg"
                >
                  <UserRound size={18} className="text-gray-400" />
                  <span className="tracking-wide">My Profile</span>
                </Link>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-3 px-4 py-3 text-sm text-gray-500 hover:bg-gray-50 hover:text-black w-full text-left transition-all duration-200 rounded-lg"
                >
                  <LogOut size={18} className="text-gray-400" />
                  <span className="tracking-wide">Sign Out</span>
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Main Content ── */}
      <main className="flex-1 flex flex-col h-screen min-h-0 min-w-0 overflow-hidden bg-gray-50/50">
        {/* Mobile Header */}
        <header className="md:hidden bg-white/80 backdrop-blur-md border-b border-gray-200 px-4 h-16 flex justify-between items-center shrink-0 z-30 shadow-sm">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsMobileMenuOpen(true)} className="p-2 -ml-2 text-black hover:bg-gray-100 rounded-lg transition-colors">
              <Menu size={20} />
            </button>
            <h1 className="font-display text-sm tracking-[0.2em] uppercase text-black">Loom</h1>
          </div>
          <button onClick={handleLogout} className="p-2 -mr-2 text-gray-400 hover:text-black hover:bg-gray-100 rounded-lg transition-colors">
            <LogOut size={18} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 md:p-8 lg:p-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
