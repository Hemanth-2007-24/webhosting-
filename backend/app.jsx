import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  LayoutDashboard, Folder, Globe, CreditCard, HelpCircle, Bell, Sun, LogOut, 
  Terminal, Settings, Cpu, HardDrive, Shield, Check, ArrowRight, Trash2, 
  Rocket, CloudLightning, Copy, FileCode, Plus, User, Key, ExternalLink, RefreshCw, X, FileUp
} from 'lucide-react';

// --- CONFIGURATION ---
const API_BASE_URL = ''; // Relative path, empty string for production

// --- GOOGLE FONTS INJECTION ---
const injectFonts = () => {
  if (!document.getElementById('premium-fonts')) {
    const link = document.createElement('link');
    link.id = 'premium-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap';
    document.head.appendChild(link);

    const style = document.createElement('style');
    style.innerHTML = `
      .font-display { font-family: 'Space Grotesk', sans-serif; }
      .font-sans { font-family: 'Inter', sans-serif; }
      @keyframes float {
        0%, 100% { transform: translateY(0px) rotate(0deg); }
        50% { transform: translateY(-15px) rotate(2deg); }
      }
      .animate-float { animation: float 6s ease-in-out infinite; }
    `;
    document.head.appendChild(style);
  }
};

export default function PremiumWebHostDashboard() {
  // --- STATE ---
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [userEmail, setUserEmail] = useState('');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [projects, setProjects] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSavedPat, setHasSavedPat] = useState(false);
  const [githubPat, setGithubPat] = useState('');
  const [repositories, setRepositories] = useState([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [toasts, setToasts] = useState([]);

  // Auth Forms
  const [authTab, setAuthTab] = useState('login');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isDeployModalOpen, setIsDeployModalOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState(null);

  // Deploy Config
  const [projectNameInput, setProjectNameInput] = useState('');
  const [rootDirInput, setRootDirInput] = useState('');
  const [deployTab, setDeployTab] = useState('github');
  const [selectedRepoUrl, setSelectedRepoUrl] = useState('');
  const [manualGitUrl, setManualGitUrl] = useState('');
  const [zipFile, setZipFile] = useState(null);
  const [useManualGitUrl, setUseManualGitUrl] = useState(false);

  // Active terminal simulation state
  const [activeDeployingProject, setActiveDeployingProject] = useState(null);
  const [terminalLogs, setTerminalLogs] = useState([]);

  // --- UTILS: TOASTS ---
  const addToast = useCallback((message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  // --- API CALL wrapper ---
  const apiFetch = useCallback(async (endpoint, options = {}) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      ...options.headers
    };
    if (!(options.body instanceof FormData) && options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(`${API_BASE_URL}/api${endpoint}`, { ...options, headers });
    if (res.status === 401) {
      localStorage.removeItem('token');
      setToken('');
      addToast('Session expired. Please log in again.', 'error');
      throw new Error('Unauthorized');
    }
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Server error');
    return data;
  }, [token, addToast]);

  // --- FETCHING LOGIC ---
  const fetchProjects = useCallback(async () => {
    if (!token) return;
    try {
      setIsLoading(true);
      const data = await apiFetch('/projects');
      setProjects(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [token, apiFetch]);

  const fetchPatStatus = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiFetch('/user/pat');
      if (data && data.pat) {
        setGithubPat(data.pat);
        setHasSavedPat(true);
      } else {
        setGithubPat('');
        setHasSavedPat(false);
      }
    } catch (err) {
      console.error(err);
    }
  }, [token, apiFetch]);

  const fetchRepos = useCallback(async () => {
    if (!token || !hasSavedPat) return;
    try {
      setIsLoadingRepos(true);
      const data = await apiFetch('/user/repos');
      setRepositories(data || []);
    } catch (err) {
      addToast('Failed to load GitHub repositories automatically.', 'error');
    } finally {
      setIsLoadingRepos(false);
    }
  }, [token, hasSavedPat, apiFetch, addToast]);

  // Sync token state changes
  useEffect(() => {
    injectFonts();
    if (token) {
      localStorage.setItem('token', token);
      fetchProjects();
      fetchPatStatus();
    } else {
      localStorage.removeItem('token');
    }
  }, [token, fetchProjects, fetchPatStatus]);

  // Trigger repositories download if modal is open and configuration has PAT
  useEffect(() => {
    if (isDeployModalOpen && hasSavedPat && deployTab === 'github') {
      fetchRepos();
    }
  }, [isDeployModalOpen, hasSavedPat, deployTab, fetchRepos]);

  // Status Poller: Periodically check status of deploying or queued projects
  useEffect(() => {
    if (!token) return;
    const hasDeploying = projects.some(p => p.status === 'deploying' || p.status === 'queued');
    if (!hasDeploying) return;

    const interval = setInterval(async () => {
      try {
        const data = await apiFetch('/projects');
        setProjects(data || []);
      } catch (err) {
        console.error("Poller failed:", err);
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [projects, token, apiFetch]);

  // --- LOG STREAMING SIMULATION FOR TERMINAL LOGS ---
  // Streams realistic, sequential terminal logs matching server.js outputs
  useEffect(() => {
    const activeProject = projects.find(p => p._id === activeDeployingProject);
    if (!activeProject) {
      setActiveDeployingProject(null);
      return;
    }

    if (activeProject.status === 'deploying') {
      setTerminalLogs([
        `[${activeProject.name}] --> Deployment accepted and initiated.`,
        `[${activeProject.name}] STEP 1: Cleaning up old deployments at workspace directory...`,
        `[${activeProject.name}] Workspace cleared successfully.`
      ]);

      const t1 = setTimeout(() => {
        setTerminalLogs(prev => [
          ...prev,
          `[${activeProject.name}] STEP 2: Preparing download channel.`,
          `[${activeProject.name}] ... Connecting to source repository.`,
          `[${activeProject.name}] ... Starting transfer of static file tree.`
        ]);
      }, 1500);

      const t2 = setTimeout(() => {
        setTerminalLogs(prev => [
          ...prev,
          `[${activeProject.name}] ... Code successfully retrieved from source context.`,
          `[${activeProject.name}] STEP 3: Executing Smart Index Finder parsing...`,
          `[${activeProject.name}] ... Root Directory config target resolved to: "${activeProject.rootDir || '(auto)'}".`
        ]);
      }, 3500);

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    } else if (activeProject.status === 'ready') {
      setTerminalLogs(prev => [
        ...prev,
        `[${activeProject.name}] STEP 4: Copied assets to deployment container context.`,
        `[${activeProject.name}] --> ✅ DEPLOYMENT SUCCEEDED. Your site is live!`,
        `[${activeProject.name}] Routing table entry activated.`
      ]);
    } else if (activeProject.status === 'failed') {
      setTerminalLogs(prev => [
        ...prev,
        `[${activeProject.name}] --> ❌ CRITICAL ERROR: Asset packaging failed. Check static file configuration.`,
        `[${activeProject.name}] ... Deployment status marked as FAILED.`
      ]);
    }
  }, [projects, activeDeployingProject]);

  // --- EVENT HANDLERS ---
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    if (!emailInput || !passwordInput) {
      addToast('Please enter both email and password.', 'error');
      return;
    }
    setIsLoading(true);
    try {
      if (authTab === 'login') {
        const data = await apiFetch('/auth/login', {
          method: 'POST',
          body: { email: emailInput, password: passwordInput }
        });
        setToken(data.token);
        setUserEmail(emailInput);
        addToast('Welcome back! Successfully logged in.', 'success');
      } else {
        await apiFetch('/auth/register', {
          method: 'POST',
          body: { email: emailInput, password: passwordInput }
        });
        addToast('Registration complete! Please log in now.', 'success');
        setAuthTab('login');
      }
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    setToken('');
    setProjects([]);
    setHasSavedPat(false);
    setGithubPat('');
    addToast('Logged out successfully.', 'success');
  };

  const handleCreateProject = async (e) => {
    e.preventDefault();
    if (projectNameInput.trim().length < 3) {
      addToast('Project name must be at least 3 characters.', 'error');
      return;
    }
    setIsLoading(true);
    try {
      const data = await apiFetch('/projects', {
        method: 'POST',
        body: { name: projectNameInput }
      });
      addToast(`Project "${data.name}" created successfully.`, 'success');
      setIsCreateModalOpen(false);
      setProjectNameInput('');
      fetchProjects();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteProject = async (projectId, name) => {
    if (!confirm(`Are you sure you want to permanently delete project "${name}"?`)) return;
    try {
      await apiFetch(`/projects/${projectId}`, { method: 'DELETE' });
      addToast(`Project "${name}" and all local files have been removed.`, 'success');
      fetchProjects();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleSavePat = async () => {
    try {
      await apiFetch('/user/pat', {
        method: 'POST',
        body: { pat: githubPat }
      });
      addToast('Personal Access Token saved to secure storage.', 'success');
      fetchPatStatus();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleDeploySubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append('projectId', selectedProject._id);
      formData.append('rootDir', rootDirInput);

      if (deployTab === 'github') {
        const finalUrl = useManualGitUrl ? manualGitUrl : selectedRepoUrl;
        if (!finalUrl) throw new Error('Please select a repository or enter a custom Git URL.');
        formData.append('gitURL', finalUrl);
      } else {
        if (!zipFile) throw new Error('Please select a .zip archive of your build.');
        formData.append('file', zipFile);
      }

      const res = await fetch(`${API_BASE_URL}/api/deploy`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Deployment setup failed.');
      }

      addToast('Deployment sequence initialized.', 'success');
      setActiveDeployingProject(selectedProject._id);
      setIsDeployModalOpen(false);
      setSelectedRepoUrl('');
      setManualGitUrl('');
      setZipFile(null);
      setRootDirInput('');
      fetchProjects();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Stats calculation
  const totalProjectsCount = projects.length;
  const activeDeploymentsCount = projects.filter(p => p.status === 'ready').length;
  const simulatedBandwidth = projects.length ? `${(projects.length * 12.4).toFixed(1)} GB` : '0 GB';
  const simulatedStorage = projects.length ? `${(projects.length * 45).toFixed(0)} MB` : '0 MB';

  return (
    <div className="font-sans min-h-screen bg-[#050816] text-white relative overflow-x-hidden select-none selection:bg-indigo-500 selection:text-white">
      
      {/* --- BACKGROUND GLOW GRAPHICS (BLUR BLOBS + GRID OVERLAY) --- */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute top-[10%] left-[15%] w-96 h-96 rounded-full bg-indigo-600/15 blur-[120px] animate-pulse" style={{ animationDuration: '8s' }}></div>
        <div className="absolute bottom-[20%] right-[10%] w-[500px] h-[500px] rounded-full bg-violet-600/10 blur-[150px] animate-pulse" style={{ animationDuration: '12s' }}></div>
        <div className="absolute top-[45%] left-[50%] -translate-x-1/2 w-80 h-80 rounded-full bg-cyan-500/10 blur-[130px] animate-pulse" style={{ animationDuration: '10s' }}></div>
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,#000_70%,transparent_100%)]"></div>
      </div>

      {/* --- FLOATING LIGHT PARTICLES (CSS FLOAT) --- */}
      <div className="absolute top-20 left-10 w-2 h-2 rounded-full bg-indigo-400/40 animate-float" style={{ animationDuration: '14s' }}></div>
      <div className="absolute top-1/2 right-24 w-3 h-3 rounded-full bg-violet-500/30 animate-float" style={{ animationDuration: '18s', animationDelay: '2s' }}></div>
      <div className="absolute bottom-1/3 left-1/3 w-2.5 h-2.5 rounded-full bg-cyan-400/30 animate-float" style={{ animationDuration: '22s', animationDelay: '1s' }}></div>

      {/* --- NAV BAR --- */}
      <nav className="sticky top-0 z-50 w-full bg-[#050816]/75 backdrop-blur-xl border-b border-white/[0.06] transition-all">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <a href="/" className="logo flex items-center gap-2 tracking-tight">
              <CloudLightning className="w-6 h-6 text-indigo-400 animate-pulse" />
              <span className="font-display font-bold text-xl bg-gradient-to-r from-white via-slate-100 to-indigo-400 bg-clip-text text-transparent">
                WebHost
              </span>
            </a>
            {token && (
              <div className="hidden md:flex items-center gap-1">
                {['dashboard', 'projects', 'deployments', 'domains', 'billing'].map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold capitalize transition-all ${
                      activeTab === tab 
                        ? 'bg-white/[0.06] text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]' 
                        : 'text-slate-400 hover:text-white hover:bg-white/[0.02]'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            {token ? (
              <>
                <button className="p-2 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/[0.12] text-slate-400 hover:text-white transition-all relative">
                  <Bell className="w-4.5 h-4.5" />
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-indigo-500 animate-ping"></span>
                </button>
                <div className="flex items-center gap-2 pl-2 border-l border-white/[0.08]">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 via-violet-500 to-cyan-500 flex items-center justify-center font-bold text-sm text-white shadow-md">
                    {userEmail ? userEmail[0].toUpperCase() : 'U'}
                  </div>
                  <button 
                    onClick={handleLogout}
                    className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/35 text-red-400 hover:text-white rounded-lg transition-all"
                  >
                    <LogOut className="w-3.5 h-3.5" /> Logout
                  </button>
                </div>
              </>
            ) : (
              <a href="#auth-section" className="btn btn-primary text-xs font-bold">
                Get Started
              </a>
            )}
          </div>
        </div>
      </nav>

      {/* --- CONTENT CONTAINER --- */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 relative z-10 min-h-[calc(100vh-10rem)]">
        
        {/* ================================================================= */}
        {/* ==                    LOGGED-OUT VIEW                          == */}
        {/* ================================================================= */}
        {!token && (
          <div className="space-y-24 py-10">
            {/* Landing Hero */}
            <div className="text-center space-y-6 max-w-4xl mx-auto">
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-bold tracking-wider uppercase mb-2 shadow-[0_0_15px_rgba(99,102,241,0.1)]"
              >
                <CloudLightning className="w-3.5 h-3.5 animate-bounce" /> Complete Edge Compute Workspace
              </motion.div>
              
              <motion.h1 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.1 }}
                className="font-display font-extrabold text-5xl sm:text-6xl md:text-7xl leading-none tracking-tight bg-gradient-to-r from-white via-slate-100 to-indigo-400 bg-clip-text text-transparent"
              >
                Deploy Static Websites in <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">Seconds</span>
              </motion.h1>

              <motion.p 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.2 }}
                className="text-slate-400 text-lg max-w-2xl mx-auto leading-relaxed"
              >
                Connect your GitHub repository or upload raw site package archives. Enjoy an automatic global CDN edge routing system with secure credential architecture.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.3 }}
                className="pt-4"
              >
                <a href="#auth-section" className="btn btn-primary btn-large group shadow-[0_0_30px_rgba(99,102,241,0.25)]">
                  Start Deploying Free <ArrowRight className="w-5 h-5 group-hover:translate-x-1.5 transition-transform" />
                </a>
              </motion.div>
            </div>

            {/* Features Info */}
            <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
              <motion.div 
                whileHover={{ y: -5 }}
                className="card bg-[#0f172a]/45 border border-white/[0.06] hover:border-indigo-500/25 p-8 rounded-[24px] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.5)] transition-all flex gap-5"
              >
                <div className="w-12 h-12 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 text-indigo-400 shrink-0">
                  <Github className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-xl mb-2 text-white">Secure GitHub Pipelines</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    Access private and public source code natively. We clone and copy build folders directly into high-availability container contexts.
                  </p>
                </div>
              </motion.div>

              <motion.div 
                whileHover={{ y: -5 }}
                className="card bg-[#0f172a]/45 border border-white/[0.06] hover:border-cyan-500/25 p-8 rounded-[24px] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.5)] transition-all flex gap-5"
              >
                <div className="w-12 h-12 rounded-xl bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20 text-cyan-400 shrink-0">
                  <FileUp className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-xl mb-2 text-white">Drag &amp; Drop Zip Packages</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">
                    No complex Git setups required. Upload compiled files inside simple ZIP structures, and our cluster unzips and serves them.
                  </p>
                </div>
              </motion.div>
            </div>

            {/* Auth section */}
            <div id="auth-section" className="max-w-md mx-auto pt-10 relative">
              <div className="absolute -inset-1.5 rounded-3xl bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 opacity-20 blur-xl"></div>
              <div className="card bg-slate-900/85 backdrop-blur-xl border border-white/[0.08] relative p-8 rounded-[28px] shadow-2xl">
                <div className="flex border-b border-white/[0.08] mb-6">
                  <button 
                    onClick={() => setAuthTab('login')}
                    className={`flex-1 py-3 text-sm font-bold tracking-wide uppercase border-b-2 transition-all ${
                      authTab === 'login' ? 'border-indigo-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Login
                  </button>
                  <button 
                    onClick={() => setAuthTab('register')}
                    className={`flex-1 py-3 text-sm font-bold tracking-wide uppercase border-b-2 transition-all ${
                      authTab === 'register' ? 'border-indigo-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Register
                  </button>
                </div>

                <form onSubmit={handleAuthSubmit} className="space-y-4">
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Email Address</label>
                    <input 
                      type="email" 
                      value={emailInput}
                      onChange={e => setEmailInput(e.target.value)}
                      className="form-input" 
                      placeholder="name@company.com" 
                      required 
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Password</label>
                    <input 
                      type="password" 
                      value={passwordInput}
                      onChange={e => setPasswordInput(e.target.value)}
                      className="form-input" 
                      placeholder="••••••••" 
                      required 
                    />
                  </div>
                  <button 
                    type="submit" 
                    disabled={isLoading}
                    className="btn btn-primary full-width py-3 shadow-lg font-bold tracking-wider uppercase text-sm"
                  >
                    {isLoading ? <span className="spinner"></span> : authTab === 'login' ? 'Access Account' : 'Create Account'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* ==                    LOGGED-IN VIEWS                          == */}
        {/* ================================================================= */}
        {token && (
          <div className="space-y-10 animate-fadeIn">
            
            {/* HERO MODULE */}
            <div className="bg-gradient-to-r from-slate-900/60 to-slate-800/20 border border-white/[0.05] p-8 sm:p-10 rounded-[28px] shadow-xl relative overflow-hidden flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
              <div className="absolute top-0 right-0 w-80 h-80 rounded-full bg-indigo-500/5 blur-[80px]"></div>
              
              <div className="space-y-3">
                <h2 className="font-display font-extrabold text-3xl sm:text-4xl bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
                  Welcome back, Creator
                </h2>
                <p className="text-slate-400 text-sm sm:text-base max-w-lg">
                  Deploy secure edge containers across static platforms. Instantly connected to MongoDB &amp; active routing structures.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold uppercase tracking-wider">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Service Operational
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-bold uppercase tracking-wider">
                    Edge Routing v1.4
                  </span>
                </div>
              </div>

              <div className="flex gap-3 shrink-0">
                <button 
                  onClick={() => setIsCreateModalOpen(true)}
                  className="btn btn-primary group shadow-[0_4px_15px_rgba(99,102,241,0.2)]"
                >
                  <Plus className="w-5 h-5 group-hover:rotate-90 transition-transform" /> Create Project
                </button>
                <button 
                  onClick={fetchProjects}
                  className="btn btn-secondary border border-white/[0.08] hover:border-white/[0.15]"
                >
                  <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} /> Sync
                </button>
              </div>
            </div>

            {/* DASHBOARD GRID CONTENT */}
            {activeTab === 'dashboard' && (
              <div className="space-y-10">
                {/* Statistics panel */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {[
                    { title: 'Active Projects', value: totalProjectsCount, label: 'Registered instances', icon: Folder, color: 'text-indigo-400' },
                    { title: 'Live Deployments', value: activeDeploymentsCount, label: 'Ready on Edge CDN', icon: Rocket, color: 'text-emerald-400' },
                    { title: 'Aggregated Storage', value: simulatedStorage, label: 'Optimized workspace', icon: HardDrive, color: 'text-violet-400' },
                    { title: 'Bandwidth (Sim)', value: simulatedBandwidth, label: 'Data served monthly', icon: Cpu, color: 'text-cyan-400' },
                  ].map((stat, idx) => {
                    const Icon = stat.icon;
                    return (
                      <div key={idx} className="card bg-[#0f172a]/45 border border-white/[0.05] hover:border-white/[0.09] p-5 rounded-2xl flex flex-col justify-between hover:scale-[1.02] transition-all">
                        <div className="flex items-center justify-between mb-4">
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">{stat.title}</span>
                          <div className={`p-2 rounded-lg bg-white/[0.03] border border-white/[0.06] ${stat.color}`}>
                            <Icon className="w-4 h-4" />
                          </div>
                        </div>
                        <div>
                          <span className="text-3xl font-extrabold tracking-tight block text-white">{stat.value}</span>
                          <span className="text-[10px] text-slate-500 font-medium block mt-1">{stat.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Main Area: Split between Projects and Active Logs */}
                <div className="grid lg:grid-cols-3 gap-8">
                  {/* Left list: Recent Projects */}
                  <div className="lg:col-span-2 space-y-5">
                    <div className="flex items-center justify-between">
                      <h3 className="font-display font-extrabold text-xl">Active Containers</h3>
                      <button onClick={() => setActiveTab('projects')} className="text-xs font-bold text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors">
                        View All <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>

                    {projects.length === 0 ? (
                      <div className="card bg-slate-900/25 border border-white/[0.05] p-12 rounded-3xl text-center space-y-4">
                        <Folder className="w-12 h-12 text-slate-500 mx-auto" />
                        <h4 className="font-display font-bold text-lg text-white">No active projects found</h4>
                        <p className="text-slate-400 text-sm max-w-md mx-auto">
                          Create your first project container to enable live Git integrations and site uploads.
                        </p>
                        <button 
                          onClick={() => setIsCreateModalOpen(true)}
                          className="btn btn-primary text-xs"
                        >
                          Launch First Container
                        </button>
                      </div>
                    ) : (
                      <div className="grid sm:grid-cols-2 gap-4">
                        {projects.slice(0, 4).map((project) => (
                          <div 
                            key={project._id}
                            className="card bg-slate-900/40 border border-white/[0.05] hover:border-indigo-500/20 p-5 rounded-[20px] flex flex-col justify-between gap-4 group transition-all"
                          >
                            <div>
                              <div className="flex items-start justify-between">
                                <h4 className="font-display font-bold text-lg text-white group-hover:text-indigo-400 transition-colors truncate max-w-[140px]">{project.name}</h4>
                                <span className={`status-badge text-[9px] px-2 py-0.5 ${project.status}`}>
                                  {project.status}
                                </span>
                              </div>
                              <a 
                                href={`/${project.subdomain}`} 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1 mt-1 truncate max-w-full"
                              >
                                {project.subdomain} <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            </div>

                            {project.rootDir && (
                              <div className="text-[10px] text-slate-500 font-bold tracking-wider uppercase block">
                                Root Dir: <span className="text-slate-300 font-mono font-medium">{project.rootDir}</span>
                              </div>
                            )}

                            <div className="flex gap-2 pt-2 border-t border-white/[0.05]">
                              <button 
                                onClick={() => {
                                  setSelectedProject(project);
                                  setIsDeployModalOpen(true);
                                }}
                                className="flex-1 btn btn-success text-xs py-1.5"
                              >
                                <Rocket className="w-3 h-3" /> Deploy
                              </button>
                              <button 
                                onClick={() => handleDeleteProject(project._id, project.name)}
                                className="p-1.5 btn btn-danger rounded-lg"
                                title="Delete Project"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right side: Simulated Console / Live Activity tracker */}
                  <div className="space-y-5">
                    <h3 className="font-display font-extrabold text-xl">System Console Logs</h3>
                    <div className="card bg-slate-950/90 border border-white/[0.08] p-5 rounded-[24px] font-mono text-xs text-slate-300 shadow-2xl h-[330px] flex flex-col justify-between relative overflow-hidden">
                      <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500"></div>
                      
                      <div className="space-y-3 overflow-y-auto pr-2 max-h-[250px] flex-1">
                        {terminalLogs.length === 0 ? (
                          <div className="text-slate-500 text-center py-20">
                            <Terminal className="w-8 h-8 mx-auto mb-2 opacity-40" />
                            <span>Awaiting deployment triggers...</span>
                          </div>
                        ) : (
                          terminalLogs.map((log, index) => (
                            <div key={index} className="leading-relaxed border-l-2 border-indigo-500/30 pl-2">
                              {log}
                            </div>
                          ))
                        )}
                      </div>
                      
                      <div className="pt-3 border-t border-white/[0.06] flex items-center justify-between text-[10px] text-slate-400">
                        <span className="flex items-center gap-1">
                          <span className={`w-2 h-2 rounded-full ${activeDeployingProject ? 'bg-amber-400 animate-ping' : 'bg-slate-600'}`}></span>
                          {activeDeployingProject ? 'Streaming live logs...' : 'Terminal idle'}
                        </span>
                        <span className="font-bold tracking-wider uppercase">Console v1.1</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* GitHub Secure PAT Manager */}
                <div className="card bg-gradient-to-tr from-slate-900 via-[#0F172A]/70 to-slate-900 border border-white/[0.06] p-6 sm:p-8 rounded-[24px]">
                  <div className="max-w-2xl space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                        <Key className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-display font-bold text-lg text-white">GitHub Integration Credentials</h3>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Configure a secure Personal Access Token to load private databases &amp; repositories natively.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-3 pt-2">
                      <input 
                        type="password" 
                        value={githubPat}
                        onChange={e => setGithubPat(e.target.value)}
                        className="form-input mb-0 flex-1 bg-black/45 border-white/[0.08] focus:border-indigo-500 text-sm font-mono"
                        placeholder="ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" 
                      />
                      <button 
                        onClick={handleSavePat}
                        className="btn btn-primary shadow-lg text-xs font-bold shrink-0 tracking-wider uppercase px-6"
                      >
                        Save Token
                      </button>
                    </div>
                    {hasSavedPat && (
                      <span className="text-[11px] text-emerald-400 font-bold flex items-center gap-1.5 pt-1">
                        <Check className="w-3.5 h-3.5 bg-emerald-500/10 border border-emerald-500/20 p-0.5 rounded-full" /> 
                        Personal Access Token configured successfully. Private repo support active.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* PROJECTS LIST TAB */}
            {activeTab === 'projects' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="font-display font-extrabold text-2xl">Project Instances</h3>
                  <button 
                    onClick={() => setIsCreateModalOpen(true)}
                    className="btn btn-primary text-xs font-bold flex items-center gap-1"
                  >
                    <Plus className="w-4 h-4" /> Create Instance
                  </button>
                </div>

                {projects.length === 0 ? (
                  <div className="card bg-slate-900/25 border border-white/[0.05] p-20 rounded-3xl text-center space-y-4">
                    <Folder className="w-16 h-16 text-slate-500 mx-auto" />
                    <h4 className="font-display font-bold text-xl text-white">No projects created yet</h4>
                    <p className="text-slate-400 text-sm max-w-md mx-auto">
                      Instances contain individual builds, custom domain settings, and deployment contexts.
                    </p>
                    <button 
                      onClick={() => setIsCreateModalOpen(true)}
                      className="btn btn-primary text-xs"
                    >
                      Create First Instance
                    </button>
                  </div>
                ) : (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {projects.map((project) => (
                      <motion.div 
                        key={project._id}
                        whileHover={{ y: -4, rotate: 0.5 }}
                        className="card bg-slate-900/40 border border-white/[0.05] hover:border-indigo-500/25 p-6 rounded-[24px] shadow-lg flex flex-col justify-between gap-6 relative overflow-hidden group transition-all"
                      >
                        <div className="space-y-4">
                          <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.05] text-indigo-400">
                                <Folder className="w-5 h-5" />
                              </div>
                              <div>
                                <h4 className="font-display font-extrabold text-lg text-white group-hover:text-indigo-400 transition-colors truncate max-w-[150px]">{project.name}</h4>
                                <span className="text-[10px] text-slate-500 block">ID: {project._id.slice(-6).toUpperCase()}</span>
                              </div>
                            </div>
                            <span className={`status-badge text-[9px] px-2 py-0.5 ${project.status}`}>
                              {project.status}
                            </span>
                          </div>

                          <div className="space-y-2 text-xs">
                            <div className="flex justify-between items-center py-1 border-b border-white/[0.03]">
                              <span className="text-slate-400 font-bold tracking-wide uppercase text-[10px]">Edge URL</span>
                              <a 
                                href={`/${project.subdomain}`} 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="text-indigo-400 hover:text-indigo-300 font-bold truncate max-w-[160px] inline-flex items-center gap-1"
                              >
                                /{project.subdomain} <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>

                            {project.rootDir && (
                              <div className="flex justify-between items-center py-1 border-b border-white/[0.03]">
                                <span className="text-slate-400 font-bold tracking-wide uppercase text-[10px]">Root Path</span>
                                <span className="text-slate-200 font-mono font-medium">{project.rootDir}</span>
                              </div>
                            )}

                            <div className="flex justify-between items-center py-1">
                              <span className="text-slate-400 font-bold tracking-wide uppercase text-[10px]">Framework</span>
                              <span className="text-slate-300">Static HTML/JS</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex gap-2 pt-2 border-t border-white/[0.05]">
                          <button 
                            onClick={() => {
                              setSelectedProject(project);
                              setIsDeployModalOpen(true);
                            }}
                            className="flex-1 btn btn-success text-xs py-2 font-bold tracking-wider uppercase"
                          >
                            <Rocket className="w-3.5 h-3.5" /> Deploy Code
                          </button>
                          <button 
                            onClick={() => handleDeleteProject(project._id, project.name)}
                            className="p-2 btn btn-danger rounded-xl"
                            title="Delete Container Instance"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TIMELINES / DEPLOYMENTS TAB */}
            {activeTab === 'deployments' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="font-display font-extrabold text-2xl">Deployment Activity</h3>
                </div>

                <div className="card bg-slate-900/40 border border-white/[0.05] p-6 sm:p-8 rounded-[24px] space-y-6">
                  {projects.length === 0 ? (
                    <div className="text-center py-12 text-slate-500">
                      Create active instances to monitor continuous delivery events.
                    </div>
                  ) : (
                    <div className="flow-root">
                      <ul className="-mb-8">
                        {projects.map((project, idx) => (
                          <li key={project._id}>
                            <div className="relative pb-8">
                              {idx !== projects.length - 1 && (
                                <span className="absolute top-4 left-4 -ml-px h-full w-0.5 bg-slate-800" aria-hidden="true" />
                              )}
                              <div className="relative flex space-x-3">
                                <div>
                                  <span className={`h-8 w-8 rounded-full flex items-center justify-center ring-8 ring-slate-900 bg-opacity-20 ${
                                    project.status === 'ready' ? 'bg-emerald-500 text-emerald-400' :
                                    project.status === 'deploying' || project.status === 'queued' ? 'bg-amber-500 text-amber-400' :
                                    'bg-red-500 text-red-400'
                                  }`}>
                                    <Terminal className="w-4 h-4" />
                                  </span>
                                </div>
                                <div className="flex-1 min-w-0 pt-1.5 flex justify-between space-x-4">
                                  <div>
                                    <p className="text-sm text-slate-300">
                                      Instance <span className="font-bold text-white font-display">{project.name}</span> status modified to{' '}
                                      <span className={`status-badge text-[9px] px-1.5 py-0.5 ${project.status}`}>{project.status}</span>
                                    </p>
                                  </div>
                                  <div className="text-right text-xs whitespace-nowrap text-slate-500 font-bold uppercase tracking-wider">
                                    Subdomain: /{project.subdomain}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* DOMAINS TAB */}
            {activeTab === 'domains' && (
              <div className="card bg-slate-900/40 border border-white/[0.05] p-12 rounded-[28px] text-center space-y-4">
                <Globe className="w-12 h-12 text-indigo-400 mx-auto" />
                <h3 className="font-display font-extrabold text-2xl">Custom Domain Routing</h3>
                <p className="text-slate-400 text-sm max-w-md mx-auto">
                  Map proprietary top-level domains directly to edge microservices. Domain mapping controls are currently integrated with internal subdomain definitions.
                </p>
              </div>
            )}

            {/* BILLING TAB */}
            {activeTab === 'billing' && (
              <div className="card bg-slate-900/40 border border-white/[0.05] p-12 rounded-[28px] text-center space-y-4">
                <CreditCard className="w-12 h-12 text-violet-400 mx-auto" />
                <h3 className="font-display font-extrabold text-2xl">Billing &amp; Usage Limits</h3>
                <p className="text-slate-400 text-sm max-w-md mx-auto">
                  You are currently on the **Premium Developer Tier**. Enjoy unrestricted container launches and global edge caching pipelines.
                </p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* --- FOOTER --- */}
      <footer className="w-full bg-[#050816]/80 backdrop-blur-md border-t border-white/[0.04] py-8 text-center text-xs text-slate-500 font-semibold relative z-10">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span>&copy; {new Date().getFullYear()} WebHost Inc. Platforms mapped globally.</span>
          <div className="flex gap-4">
            <a href="#" className="hover:text-white transition-colors">Documentation</a>
            <a href="#" className="hover:text-white transition-colors">API References</a>
            <a href="#" className="hover:text-white transition-colors">Discord</a>
            <a href="#" className="hover:text-white transition-colors">Status</a>
          </div>
        </div>
      </footer>

      {/* ================================================================= */}
      {/* ==                       MODALS & POPUPS                        == */}
      {/* ================================================================= */}
      <AnimatePresence>
        
        {/* --- CREATE PROJECT MODAL --- */}
        {isCreateModalOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              transition={{ type: 'spring', damping: 25, stiffness: 350 }}
              className="card bg-slate-900/95 border border-white/[0.08] w-full max-w-md p-6 sm:p-8 rounded-[28px] shadow-2xl relative"
            >
              <button 
                onClick={() => setIsCreateModalOpen(false)}
                className="absolute top-4 right-4 p-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] text-slate-400 hover:text-white hover:bg-white/[0.08] transition-all"
              >
                <X className="w-4 h-4" />
              </button>

              <h3 className="modal-title font-display font-extrabold text-2xl mb-4 text-white">Create New Instance</h3>
              
              <form onSubmit={handleCreateProject} className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Instance Name</label>
                  <input 
                    type="text" 
                    value={projectNameInput}
                    onChange={e => setProjectNameInput(e.target.value)}
                    className="form-input" 
                    placeholder="my-lightning-app" 
                    required 
                  />
                  <span className="text-[10px] text-slate-500 font-medium block mt-1 leading-relaxed">
                    Used to provision routing coordinates. (e.g., /my-lightning-app-xyz)
                  </span>
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <button 
                    type="button" 
                    onClick={() => setIsCreateModalOpen(false)}
                    className="btn btn-secondary text-xs font-bold"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit" 
                    disabled={isLoading}
                    className="btn btn-primary text-xs font-bold px-5"
                  >
                    {isLoading ? <span className="spinner"></span> : 'Provision Instance'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}

        {/* --- DEPLOY INSTANCE MODAL --- */}
        {isDeployModalOpen && selectedProject && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md"
          >
            <motion.div 
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              transition={{ type: 'spring', damping: 25, stiffness: 350 }}
              className="card bg-slate-900/95 border border-white/[0.08] w-full max-w-lg p-6 sm:p-8 rounded-[28px] shadow-2xl relative"
            >
              <button 
                onClick={() => setIsDeployModalOpen(false)}
                className="absolute top-4 right-4 p-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] text-slate-400 hover:text-white hover:bg-white/[0.08] transition-all"
              >
                <X className="w-4 h-4" />
              </button>

              <h3 className="modal-title font-display font-extrabold text-2xl mb-1 text-white">Deploy static assets</h3>
              <p className="text-slate-400 text-xs mb-6">Targeting Instance: <span className="text-white font-bold">{selectedProject.name}</span></p>
              
              <form onSubmit={handleDeploySubmit} className="space-y-4">
                <div className="deploy-tabs bg-white/[0.02] p-1.5 rounded-xl border border-white/[0.05] mb-4">
                  <button 
                    type="button"
                    onClick={() => setDeployTab('github')}
                    className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg transition-all ${
                      deployTab === 'github' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    GitHub Pipeline
                  </button>
                  <button 
                    type="button"
                    onClick={() => setDeployTab('upload')}
                    className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg transition-all ${
                      deployTab === 'upload' ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Direct Zip Upload
                  </button>
                </div>

                {deployTab === 'github' ? (
                  <div className="space-y-4 animate-fadeIn">
                    {hasSavedPat && !useManualGitUrl ? (
                      <div className="space-y-4">
                        <div>
                          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Select Repository</label>
                          <select 
                            value={selectedRepoUrl}
                            onChange={e => setSelectedRepoUrl(e.target.value)}
                            className="form-input bg-slate-950 border-white/[0.08]"
                            required
                          >
                            <option value="">-- Choose Repository --</option>
                            {repositories.map((repo, idx) => (
                              <option key={idx} value={repo.clone_url}>
                                {repo.name} {repo.private ? '(Private)' : '(Public)'}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button 
                          type="button"
                          onClick={() => setUseManualGitUrl(true)}
                          className="text-xs font-bold text-indigo-400 hover:text-indigo-300"
                        >
                          Or enter manual repository link instead
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div>
                          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Git Clone HTTPS URL</label>
                          <input 
                            type="url" 
                            value={manualGitUrl}
                            onChange={e => setManualGitUrl(e.target.value)}
                            className="form-input" 
                            placeholder="https://github.com/username/repo.git" 
                            required={useManualGitUrl || !hasSavedPat}
                          />
                        </div>
                        {hasSavedPat && (
                          <button 
                            type="button"
                            onClick={() => setUseManualGitUrl(false)}
                            className="text-xs font-bold text-indigo-400 hover:text-indigo-300"
                          >
                            Return to Auto-Discovery List
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4 animate-fadeIn">
                    <div>
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Direct ZIP archive</label>
                      <input 
                        type="file" 
                        onChange={e => setZipFile(e.target.files[0])}
                        className="form-input text-sm p-3 bg-slate-950/50 border-white/[0.08]" 
                        accept=".zip"
                        required 
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Root Directory override (Optional)</label>
                  <input 
                    type="text" 
                    value={rootDirInput}
                    onChange={e => setRootDirInput(e.target.value)}
                    className="form-input" 
                    placeholder="e.g. dist, build, public" 
                  />
                  <span className="text-[10px] text-slate-500 font-medium block leading-normal mt-1">
                    Path to static directory holding index.html. Left empty, our Smart Index Finder crawls and links automatically.
                  </span>
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <button 
                    type="button" 
                    onClick={() => setIsDeployModalOpen(false)}
                    className="btn btn-secondary text-xs font-bold"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit" 
                    disabled={isLoading}
                    className="btn btn-success text-xs font-bold px-5"
                  >
                    {isLoading ? <span className="spinner"></span> : 'Deploy to Edge CDN'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}

      </AnimatePresence>

      {/* --- TOASTS NOTIFICATIONS SYSTEM --- */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[300] flex flex-col gap-2">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div 
              key={t.id}
              initial={{ opacity: 0, y: 50, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', damping: 20, stiffness: 300 }}
              className={`px-4 py-3 rounded-xl border text-sm font-bold tracking-wide shadow-2xl flex items-center gap-2 ${
                t.type === 'success' 
                  ? 'bg-emerald-500/15 border-emerald-500/25 text-emerald-400' 
                  : 'bg-red-500/15 border-red-500/25 text-red-400'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${t.type === 'success' ? 'bg-emerald-400 animate-ping' : 'bg-red-400 animate-ping'}`}></span>
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

    </div>
  );
}
