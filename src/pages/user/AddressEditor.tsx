import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ChevronRight } from 'lucide-react';
import { Header } from '../../components/layout/Header';
import { Footer } from '../../components/layout/Footer';
import { FormSkeleton } from '../../components/common/Skeleton';
import AddressForm from '../../components/AddressForm';
import type { Address } from '../../components/AddressForm';
import { useAuth } from '../../contexts/AuthContext';
import logger from '../../utils/logger';
import { getUserAddresses, createUserAddress, updateUserAddress, setDefaultUserAddress } from '../../lib/adminService';

const ADDRESSES_PATH = '/profile?section=addresses';

const AddressEditor: React.FC = () => {
  const navigate = useNavigate();
  const { addressId } = useParams<{ addressId?: string }>();
  const isEditing = Boolean(addressId);
  const { user, currentAuthUser, loading: authLoading } = useAuth();
  const userId = user?.id || currentAuthUser?.userId;

  const [address, setAddress] = useState<Address | undefined>();
  const [existingCount, setExistingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      navigate('/login');
      return;
    }

    let isCurrent = true;
    const load = async () => {
      try {
        setLoading(true);
        const { data } = await getUserAddresses(userId);
        if (!isCurrent) return;
        setExistingCount(data.length);

        if (addressId) {
          const row: any = data.find((a: any) => a.id === addressId);
          if (!row) {
            setError('This address could not be found.');
            return;
          }
          setAddress({
            id: row.id,
            fullName: row.full_name || '',
            phoneNumber: row.phone_number || '',
            email: row.email || '',
            country: row.country || '',
            streetAddress1: row.street_address_1 || '',
            streetAddress2: row.street_address_2 || '',
            city: row.city || '',
            state: row.state || '',
            postalCode: row.postal_code || '',
            addressType: (row.address_type || 'home') as 'home' | 'work' | 'other',
            deliveryNotes: row.delivery_notes || '',
            isDefault: Boolean(row.is_default),
            createdAt: row.created_at || new Date().toISOString(),
            updatedAt: row.updated_at || new Date().toISOString(),
          });
        }
      } catch (err) {
        logger.error(err as Error, { context: 'Failed to load address for editing' });
        if (isCurrent) setError('Failed to load address.');
      } finally {
        if (isCurrent) setLoading(false);
      }
    };

    void load();
    return () => {
      isCurrent = false;
    };
  }, [addressId, userId, authLoading, navigate]);

  const handleSubmit = async (data: Address) => {
    if (!userId) return;
    try {
      setSaving(true);
      setError(null);

      const payload = {
        full_name: data.fullName,
        phone_number: data.phoneNumber,
        email: data.email || '',
        country: data.country || '',
        street_address_1: data.streetAddress1,
        street_address_2: data.streetAddress2 || '',
        city: data.city,
        state: data.state,
        postal_code: data.postalCode,
        address_type: data.addressType,
        delivery_notes: data.deliveryNotes || '',
      };

      const result = addressId
        ? await updateUserAddress(addressId, { ...payload, is_default: data.isDefault })
        : await createUserAddress({
            ...payload,
            user_id: userId,
            is_default: data.isDefault || existingCount === 0,
          });

      if (result.error) throw new Error(result.error);

      // Keep a single default address per user.
      const savedId = (result.data as { id?: string } | null)?.id || addressId;
      if (savedId && (data.isDefault || (!addressId && existingCount === 0))) {
        const defaultResult = await setDefaultUserAddress(userId, savedId);
        if (defaultResult.error) throw new Error(defaultResult.error);
      }
      navigate(ADDRESSES_PATH);
    } catch (err) {
      logger.error(err as Error, { context: 'Failed to save address' });
      setError('Failed to save address. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const title = isEditing ? 'Edit your address' : 'Add a new address';

  return (
    <div className="profile-page-shell">
      <Header />
      <main className="profile-page-main">
        <div className="addr-page">
          <nav className="profile-breadcrumb" aria-label="Breadcrumb">
            <button type="button" onClick={() => navigate('/profile')} className="profile-breadcrumb-link">
              My Account
            </button>
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" aria-hidden />
            <button type="button" onClick={() => navigate(ADDRESSES_PATH)} className="profile-breadcrumb-link">
              My Addresses
            </button>
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" aria-hidden />
            <span className="profile-breadcrumb-current">{isEditing ? 'Edit address' : 'Add address'}</span>
          </nav>

          {error && (
            <div className="auth-alert auth-alert--error mb-5">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span className="flex-1">{error}</span>
            </div>
          )}

          {loading ? (
            <div className="addr-form">
              <h1 className="addr-page-title">{title}</h1>
              <FormSkeleton fields={6} />
            </div>
          ) : isEditing && !address ? (
            <div className="addr-form">
              <h1 className="addr-page-title">{title}</h1>
              <button type="button" onClick={() => navigate(ADDRESSES_PATH)} className="addr-btn addr-btn--secondary">
                Back to My Addresses
              </button>
            </div>
          ) : (
            <AddressForm
              key={address?.id || 'new'}
              initialData={address}
              onSubmit={handleSubmit}
              onCancel={() => navigate(ADDRESSES_PATH)}
              isLoading={saving}
            />
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default AddressEditor;
