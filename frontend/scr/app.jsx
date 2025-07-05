// frontend/src/App.jsx
import React, { useState, useEffect, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route, Link, useNavigate, Navigate } from 'react-router-dom';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import Spline from '@splinetool/react-spline';
import { GitBranch, UploadCloud, Plus, LogOut, Loader2 } from 'lucide-react';

// --- API Setup ---
// On Render, Vite's dev server proxy doesn't work. We need the full URL.
// The backend URL will be available from the environment.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:10000/api'
});

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// --- Auth Context ---
const AuthContext = createContext(null);
const AuthProvider = ({ children }) => {
    const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('token'));
    const navigate = useNavigate();
    
    const login = (token) => {
        localStorage.setItem('token', token);
        setIsAuthenticated(true);
        navigate('/dashboard');
    };
    const logout = () => {
        localStorage.removeItem('token');
        setIsAuthenticated(false);
        navigate('/login');
    };
    return <AuthContext.Provider value={{ isAuthenticated, login, logout }}>{children}</AuthContext.Provider>;
};
const useAuth = () => useContext(AuthContext);

// --- Reusable Components ---
const Navbar = () => {
    const { isAuthenticated, logout } = useAuth();
    return (
        <nav className="container mx-auto p-4 flex justify-between items-center">
            <Link to="/" className="text-2xl font-bold text-white">Deploy<span className="text-indigo-400">Sphere</span></Link>
            <div>
                {isAuthenticated ? (
                    <button onClick={logout} className="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-lg flex items-center gap-2">
                        <LogOut size={18} /> Logout
                    </button>
                ) : (
                    <div className="space-x-4">
                        <Link to="/login" className="font-semibold hover:text-indigo-400">Login</Link>
                        <Link to="/register" className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2 px-4 rounded-lg">Sign Up</Link>
                    </div>
                )}
            </div>
        </nav>
    );
};

// --- Page Components ---
const HomePage = () => (
    <div className="relative h-[calc(100vh-100px)] flex flex-col items-center justify-center text-center overflow-hidden">
        <div className="absolute inset-0 z-0 opacity-50">
            <Spline scene="https://prod.spline.design/iR-2E5g0R5MYN49h/scene.splinecode" />
        </div>
        <div className="relative z-10 bg-slate-900/50 backdrop-blur-sm p-8 rounded-xl">
            <h1 className="text-5xl md:text-7xl font-bold text-white mb-4">Deploy with Ease.</h1>
            <p className="text-xl text-slate-300 mb-8">The simplest way to host your static sites from Git or ZIP.</p>
            <Link to="/register" className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 px-8 rounded-full text-lg transition-all shadow-lg shadow-indigo-500/30">Get Started Now</Link>
        </div>
    </div>
);

const AuthForm = ({ isLogin }) => {
    const { login } = useAuth();
    const navigate = useNavigate();
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        const endpoint = isLogin ? '/login' : '/register';
        const payload = { email: e.target.email.value, password: e.target.password.value };
        try {
            const { data } = await api.post(endpoint, payload);
            if (isLogin) {
                login(data.token);
            } else {
                alert('Registration successful! Please log in.');
                navigate('/login');
            }
        } catch (err) {
            setError(err.response?.data?.message || 'An error occurred.');
        } finally {
            setLoading(false);
        }
    };
    return (
      <div className="flex items-center justify-center py-12">
        <motion.div initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full max-w-md bg-slate-800 p-8 rounded-2xl shadow-2xl">
            <h2 className="text-3xl font-bold text-center mb-6">{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
            <form onSubmit={handleSubmit} className="space-y-6">
                <input name="email" type="email" placeholder="Email" required className="w-full bg-slate-700 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
                <input name="password" type="password" placeholder="Password" required className="w-full bg-slate-700 p-3 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
                {error && <p className="text-red-400 text-sm">{error}</p>}
                <button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-lg transition-all flex items-center justify-center">
                    {loading ? <Loader2 className="animate-spin" /> : (isLogin ? 'Login' : 'Register')}
                </button>
            </form>
        </motion.div>
      </div>
    );
};

const DashboardPage = () => {
    const [projects, setProjects] = useState([]);
    const [loading, setLoading] = useState(true);
    const [modal, setModal] = useState({ type: null, data: null }); // type: 'create' or 'deploy'
    const platformDomain = import.meta.env.VITE_PLATFORM_DOMAIN || 'platform-api.onrender.com';

    const fetchProjects = async () => {
        try {
            const { data } = await api.get('/projects');
            setProjects(data);
        } catch (error) {
            console.error("Failed to fetch projects", error);
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { fetchProjects(); }, []);

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            await api.post('/projects', { name: e.target.projectName.value });
            fetchProjects();
            setModal({ type: null });
        } catch (err) { alert(err.response?.data?.message || 'Failed to create'); }
    };

    const handleDeploy = async (e) => {
        e.preventDefault();
        const formData = new FormData();
        formData.append('projectId', modal.data._id);
        if (e.target.gitURL.value) formData.append('gitURL', e.target.gitURL.value);
        if (e.target.file.files[0]) formData.append('file', e.target.file.files[0]);
        
        try {
            const res = await api.post('/deploy', formData);
            alert(res.data.message);
            fetchProjects();
            setModal({ type: null });
        } catch (err) { alert(err.response?.data?.message || 'Deployment failed'); }
    };

    return (
        <div className="p-4 md:p-8">
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-4xl font-bold">Dashboard</h1>
                <button onClick={() => setModal({ type: 'create' })} className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2 px-4 rounded-lg flex items-center gap-2"><Plus size={20} /> New Project</button>
            </div>
            {loading ? <p>Loading projects...</p> : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {projects.map(p => (
                        <motion.div key={p._id} layout className="bg-slate-800 rounded-lg p-6 shadow-lg flex flex-col justify-between">
                            <div>
                                <h2 className="text-2xl font-semibold mb-2">{p.name}</h2>
                                <a href={`https://${p.subdomain}.${platformDomain}`} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline break-all">{`${p.subdomain}.${platformDomain}`}</a>
                                <p className={`mt-4 text-sm font-semibold capitalize ${p.status === 'ready' ? 'text-green-400' : 'text-yellow-400'}`}>Status: {p.status}</p>
                            </div>
                            <button onClick={() => setModal({ type: 'deploy', data: p })} className="mt-6 bg-green-600 hover:bg-green-500 text-white font-bold py-2 px-4 rounded-lg w-full">Deploy Update</button>
                        </motion.div>
                    ))}
                </div>
            )}
            
            <AnimatePresence>
                {modal.type && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
                        <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }} className="bg-slate-800 p-8 rounded-lg w-full max-w-md shadow-2xl">
                            {modal.type === 'create' && <>
                                <h2 className="text-2xl mb-4">Create New Project</h2>
                                <form onSubmit={handleCreate}>
                                    <input name="projectName" placeholder="my-awesome-site" required className="w-full bg-slate-700 p-3 rounded mb-4" />
                                    <div className="flex justify-end gap-4">
                                        <button type="button" onClick={() => setModal({type: null})} className="bg-slate-600 py-2 px-4 rounded">Cancel</button>
                                        <button type="submit" className="bg-indigo-600 py-2 px-4 rounded">Create</button>
                                    </div>
                                </form>
                            </>}
                            {modal.type === 'deploy' && <>
                                <h2 className="text-2xl mb-4">Deploy to "{modal.data.name}"</h2>
                                <form onSubmit={handleDeploy} className="space-y-6">
                                    <input name="gitURL" type="url" placeholder="https://github.com/user/repo.git" className="w-full bg-slate-700 p-3 rounded" />
                                    <div className="text-center text-slate-400">OR</div>
                                    <input name="file" type="file" accept=".zip" className="w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-100 file:text-indigo-700 hover:file:bg-indigo-200" />
                                    <div className="flex justify-end gap-4">
                                        <button type="button" onClick={() => setModal({type: null})} className="bg-slate-600 py-2 px-4 rounded">Cancel</button>
                                        <button type="submit" className="bg-green-600 py-2 px-4 rounded">Deploy</button>
                                    </div>
                                </form>
                            </>}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// --- Main App Router ---
export default function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <Navbar />
                <main className="container mx-auto px-4">
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/login" element={<AuthForm isLogin />} />
                        <Route path="/register" element={<AuthForm />} />
                        <Route path="/dashboard" element={<PrivateRoute><DashboardPage /></PrivateRoute>} />
                    </Routes>
                </main>
            </AuthProvider>
        </BrowserRouter>
    );
}
const PrivateRoute = ({ children }) => {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? children : <Navigate to="/login" />;
};