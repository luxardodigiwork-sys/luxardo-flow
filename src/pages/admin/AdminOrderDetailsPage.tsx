import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Package, CheckCircle2, Box, Send, ShieldCheck, Lock, Unlock } from 'lucide-react';
import { storage } from '../../utils/localStorage';
import { Order } from '../../types';
import { formatCurrency } from '../../utils/currency';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { updateOrderStatusInFirestore } from '../../utils/ordersFirestore';

export default function AdminOrderDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [order, setOrder] = useState<Order | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [trackingInput, setTrackingInput] = useState('');
  const [courierName, setCourierName] = useState('DTDC');
  const [courierService, setCourierService] = useState('Express');
  const [pickupDate, setPickupDate] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [invoiceSent, setInvoiceSent] = useState(false);

  const basePath = location.pathname.split('/')[1];

  useEffect(() => {
    const fetchOrder = async () => {
      if (!id) return;
      try {
        let foundOrder: Order | null = null;
        try {
          const snap = await getDoc(doc(db, 'orders', id));
          if (snap.exists()) {
            foundOrder = { id: snap.id, ...snap.data() } as Order;
          }
        } catch (fsErr) {
          console.warn('[AdminOrderDetails] Firestore fetch failed, using cache:', fsErr);
        }
        if (!foundOrder) {
          foundOrder = storage.getOrders().find(o => o.id === id) || null;
        }
        if (foundOrder) {
          setOrder(foundOrder);
          setTrackingInput(foundOrder.trackingId || '');
          setCourierName(foundOrder.courierName || 'DTDC');
          setCourierService(foundOrder.courierService || 'Express');
          setPickupDate(foundOrder.dispatchDate || new Date().toISOString().split('T')[0]);
          setTrackingUrl(foundOrder.trackingUrl || '');
        } else {
          navigate(`/${basePath}/dashboard`);
        }
      } catch (error) {
        console.error('Error fetching order:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchOrder();
  }, [id, navigate, basePath]);

  const handleSaveDispatchDetails = async () => {
    if (!order) return;
    setIsUpdating(true);
    try {
      const patch = { trackingId: trackingInput, courierName, courierService, dispatchDate: pickupDate, trackingUrl };
      await updateOrderStatusInFirestore(order.id, patch);
      setOrder({ ...order, ...patch });
    } catch (error: any) {
      alert('Failed to save dispatch details: ' + (error?.message || 'Unknown'));
    } finally {
      setIsUpdating(false);
    }
  };

  const handleResendInvoice = async () => {
    if (!order) return;
    try {
      await updateOrderStatusInFirestore(order.id, { resendInvoiceRequestedAt: new Date().toISOString() } as any);
      setInvoiceSent(true);
      setTimeout(() => setInvoiceSent(false), 3000);
    } catch (e: any) {
      alert('Failed to flag invoice resend: ' + (e?.message || 'Unknown'));
    }
  };

  const handleStatusChange = async (newStatus: Order['status']) => {
    if (!order) return;
    setIsUpdating(true);
    try {
      await updateOrderStatusInFirestore(order.id, { status: newStatus });
      setOrder({ ...order, status: newStatus });
    } catch (error: any) {
      alert('Failed to update order status: ' + (error?.message || 'Unknown'));
    } finally {
      setIsUpdating(false);
    }
  };

  const handleVerificationStatusChange = async (newStatus: Order['verificationStatus']) => {
    if (!order) return;
    setIsUpdating(true);
    try {
      await updateOrderStatusInFirestore(order.id, { verificationStatus: newStatus });
      setOrder({ ...order, verificationStatus: newStatus });
    } catch (error: any) {
      alert('Failed to update verification status: ' + (error?.message || 'Unknown'));
    } finally {
      setIsUpdating(false);
    }
  };

  // --- NEW: ACCOUNTS APPROVAL LOGIC ---
  const handleAccountsApproval = async (approved: boolean) => {
    if (!order) return;
    if (!confirm(approved ? 'Approve payment and unlock this order for Dispatch team?' : 'Revoke approval and lock this order from Dispatch?')) return;
    
    setIsUpdating(true);
    try {
      await updateOrderStatusInFirestore(order.id, { isAccountsApproved: approved });
      setOrder({ ...order, isAccountsApproved: approved });
    } catch (error: any) {
      alert('Failed to update accounts approval: ' + (error?.message || 'Unknown'));
    } finally {
      setIsUpdating(false);
    }
  };

  if (isLoading) return <div className="min-h-[400px] flex items-center justify-center"><div className="w-12 h-12 border-4 border-brand-divider border-t-brand-black rounded-full animate-spin"></div></div>;
  if (!order) return null;

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-20">
      <div className="flex items-center gap-4">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-brand-bg rounded-full transition-colors">
          <ArrowLeft size={24} />
        </button>
        <div>
          <h1 className="text-3xl font-display uppercase tracking-tight">Order Details</h1>
          <p className="text-brand-secondary font-sans text-sm mt-1">
            <span className="font-mono">{order.id}</span> • {new Date(order.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Order Items */}
          <div className="bg-white border border-brand-divider p-6 shadow-sm space-y-6">
            <h2 className="text-sm uppercase tracking-widest font-bold text-brand-secondary border-b border-brand-divider pb-4">
              Order Items ({order.items.length})
            </h2>
            <div className="space-y-6">
              {order.items.map((item, index) => (
                <div key={index} className="flex justify-between items-center py-2">
                  <div className="flex items-center gap-6">
                    <div className="w-20 h-24 bg-brand-bg flex items-center justify-center border border-brand-divider shrink-0 overflow-hidden">
                      {item.image ? <img src={item.image} alt={item.name} className="w-full h-full object-cover" /> : <Package size={24} className="text-brand-secondary" />}
                    </div>
                    <div className="space-y-1">
                      <p className="font-display text-lg text-brand-black">{item.name}</p>
                      <p className="text-[10px] uppercase tracking-widest font-bold text-brand-secondary">{item.category || 'Uncategorized'}</p>
                      <p className="text-xs text-brand-secondary mt-2">Qty: <span className="text-brand-black font-medium">{item.quantity}</span> × {formatCurrency(item.price)}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-sans font-medium text-brand-black">{formatCurrency(item.price * item.quantity)}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="pt-4 border-t border-brand-divider space-y-2">
              <div className="flex justify-between text-base font-bold pt-4 mt-2 border-t border-brand-divider">
                <span className="text-brand-black">Total</span>
                <span className="text-brand-black">{formatCurrency(order.totalAmount)}</span>
              </div>
            </div>
          </div>

          {/* Payment, Status & ACCOUNTS APPROVAL */}
          <div className="bg-white border border-brand-divider p-6 shadow-sm space-y-6 relative overflow-hidden">
            {/* The Lock/Unlock UI for Accounts */}
            <div className={`absolute top-0 left-0 w-1.5 h-full ${order.isAccountsApproved ? 'bg-emerald-500' : 'bg-red-500'}`} />
            
            <div className="flex items-center justify-between border-b border-brand-divider pb-4">
              <h2 className="text-sm uppercase tracking-widest font-bold text-brand-secondary">Payment & Accounts Approval</h2>
              <button
                onClick={() => handleAccountsApproval(!order.isAccountsApproved)}
                disabled={isUpdating}
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all ${
                  order.isAccountsApproved 
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100' 
                    : 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                }`}
              >
                {order.isAccountsApproved ? <><Unlock size={14} /> Dispatch Unlocked</> : <><Lock size={14} /> Locked for Dispatch</>}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <p className="text-brand-secondary text-xs mb-2">Payment Status</p>
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold border bg-emerald-50 text-emerald-700 border-emerald-200">
                    {order.paymentStatus || 'Paid'}
                  </span>
                </div>
                <div>
                  <p className="text-brand-secondary text-xs mb-1">Payment Method</p>
                  <p className="font-medium text-sm text-brand-black uppercase tracking-widest">
                    {order.paymentMethod === 'cod' ? 'Cash on Delivery (COD)' : 'Prepaid / Online Payment'}
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-brand-secondary text-xs mb-2">Order Status</p>
                  <select
                    value={order.status}
                    onChange={(e) => handleStatusChange(e.target.value as Order['status'])}
                    disabled={isUpdating || order.status === 'cancelled'}
                    className="text-xs font-medium px-4 py-2 w-full border rounded-full focus:outline-none"
                  >
                    <option value="pending">Pending</option>
                    <option value="processing">Processing</option>
                    <option value="packed">Packed</option>
                    <option value="shipped">Shipped</option>
                    <option value="delivered">Delivered</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
              </div>
            </div>
            {!order.isAccountsApproved && (
               <div className="bg-red-50 border border-red-100 p-4 rounded-lg flex items-start gap-3 mt-4 text-red-700 text-xs">
                 <Lock size={16} className="mt-0.5 shrink-0" />
                 <p>This order is currently <strong>LOCKED</strong>. Dispatch team cannot pack or ship this order until you click the button above to approve the payment.</p>
               </div>
            )}
          </div>
        </div>

        {/* Right Column: Customer & Shipping */}
        <div className="space-y-8">
          <div className="bg-white border border-brand-divider p-6 shadow-sm space-y-4">
            <h2 className="text-sm uppercase tracking-widest font-bold text-brand-secondary border-b border-brand-divider pb-4">Customer Info</h2>
            <div className="space-y-4 text-sm">
              <p><span className="text-brand-secondary text-xs block mb-1">Name</span><span className="font-medium text-brand-black">{order.userName}</span></p>
              <p><span className="text-brand-secondary text-xs block mb-1">Phone</span><span className="font-medium text-brand-black">{order.shippingAddress?.phone || 'N/A'}</span></p>
            </div>
          </div>
          <div className="bg-white border border-brand-divider p-6 shadow-sm space-y-4">
            <h2 className="text-sm uppercase tracking-widest font-bold text-brand-secondary border-b border-brand-divider pb-4">Shipping Info</h2>
            {order.shippingAddress ? (
              <div className="space-y-1 text-sm text-brand-black">
                <p className="font-medium mb-2">{order.shippingAddress.fullName}</p>
                <p>{order.shippingAddress.addressLine1}</p>
                <p>{order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.postalCode}</p>
              </div>
            ) : <p className="text-sm text-brand-secondary">No address.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}