import React, { useEffect, useState } from 'react';
import { Home, Briefcase, MoreHorizontal } from 'lucide-react';
import { fetchCountries, type Country } from '../lib/shippingDataService';

export interface Address {
  id: string;
  fullName: string;
  phoneNumber: string;
  email: string;
  country: string;
  streetAddress1: string;
  streetAddress2?: string;
  city: string;
  state: string;
  postalCode: string;
  addressType: 'home' | 'work' | 'other';
  deliveryNotes?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AddressFormProps {
  initialData?: Address;
  onSubmit: (data: Address) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

const AddressForm: React.FC<AddressFormProps> = ({
  initialData,
  onSubmit,
  onCancel,
  isLoading = false,
}) => {
  const [formData, setFormData] = useState<Partial<Address>>(
    initialData || {
      fullName: '',
      phoneNumber: '',
      email: '',
      country: '',
      streetAddress1: '',
      streetAddress2: '',
      city: '',
      state: '',
      postalCode: '',
      addressType: 'home',
      deliveryNotes: '',
      isDefault: false,
    }
  );

  const [countries, setCountries] = useState<Country[]>([]);
  const [countriesLoading, setCountriesLoading] = useState(true);
  const [countriesError, setCountriesError] = useState(false);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  useEffect(() => {
    let isCurrent = true;

    const loadCountries = async () => {
      try {
        const { data, error } = await fetchCountries();
        if (!isCurrent) return;
        if (error) throw new Error(error);
        setCountries(data || []);
      } catch {
        if (isCurrent) setCountriesError(true);
      } finally {
        if (isCurrent) setCountriesLoading(false);
      }
    };

    void loadCountries();
    return () => {
      isCurrent = false;
    };
  }, []);

  const requiredFields = [
    'fullName',
    'phoneNumber',
    'email',
    'country',
    'streetAddress1',
    'city',
    'state',
    'postalCode',
  ];

  const validateForm = () => {
    const newErrors: { [key: string]: string } = {};

    requiredFields.forEach((field) => {
      if (!formData[field as keyof Address] || formData[field as keyof Address] === '') {
        newErrors[field] = `${field.replace(/([A-Z])/g, ' $1').trim()} is required`;
      }
    });

    // Email validation
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address';
    }

    // Phone validation (basic)
    if (formData.phoneNumber && !/^\+?[\d\s\-()]{7,}$/.test(formData.phoneNumber)) {
      newErrors.phoneNumber = 'Please enter a valid phone number';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value, type } = e.target;
    setFormData({
      ...formData,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value,
    });
    // Clear error for this field when user starts typing
    if (errors[name]) {
      setErrors({ ...errors, [name]: '' });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateForm()) {
      const finalData: Address = {
        id: initialData?.id || `addr_${Date.now()}`,
        fullName: formData.fullName || '',
        phoneNumber: formData.phoneNumber || '',
        email: formData.email || '',
        country: formData.country || '',
        streetAddress1: formData.streetAddress1 || '',
        streetAddress2: formData.streetAddress2 || '',
        city: formData.city || '',
        state: formData.state || '',
        postalCode: formData.postalCode || '',
        addressType: (formData.addressType as 'home' | 'work' | 'other') || 'home',
        deliveryNotes: formData.deliveryNotes || '',
        isDefault: formData.isDefault || false,
        createdAt: initialData?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      onSubmit(finalData);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-50 border border-gray-200 rounded-2xl p-6 md:p-8">
      <h3 className="text-lg font-semibold text-amber-600 mb-6">
        {initialData ? 'Edit Address' : 'Add New Address'}
      </h3>

      <div className="space-y-6">
        {/* Full Name */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            Full Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="fullName"
            value={formData.fullName || ''}
            onChange={handleChange}
            placeholder="Enter your full name"
            className={`w-full px-4 py-3 bg-gray-100 border rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors ${
              errors.fullName ? 'border-red-500' : 'border-gray-200'
            }`}
          />
          {errors.fullName && <p className="text-red-500 text-xs mt-1">{errors.fullName}</p>}
        </div>

        {/* Phone Number */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            Phone Number <span className="text-red-500">*</span>
          </label>
          <input
            type="tel"
            name="phoneNumber"
            value={formData.phoneNumber || ''}
            onChange={handleChange}
            placeholder="+91 99999 99999"
            className={`w-full px-4 py-3 bg-gray-100 border rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors ${
              errors.phoneNumber ? 'border-red-500' : 'border-gray-200'
            }`}
          />
          {errors.phoneNumber && <p className="text-red-500 text-xs mt-1">{errors.phoneNumber}</p>}
        </div>

        {/* Email Address */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            Email Address <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            name="email"
            value={formData.email || ''}
            onChange={handleChange}
            placeholder="your@email.com"
            className={`w-full px-4 py-3 bg-gray-100 border rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors ${
              errors.email ? 'border-red-500' : 'border-gray-200'
            }`}
          />
          {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email}</p>}
        </div>

        {/* Country */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            Country <span className="text-red-500">*</span>
          </label>
          <select
            name="country"
            value={formData.country || ''}
            onChange={handleChange}
            disabled={countriesLoading}
            className={`w-full px-4 py-3 bg-gray-100 border rounded-lg text-gray-900 focus:outline-none focus:border-amber-500 transition-colors ${
              errors.country ? 'border-red-500' : 'border-gray-200'
            }`}
          >
            <option value="">Select a country</option>
            {formData.country && !countries.some((country) => country.country_name === formData.country) && (
              <option value={formData.country}>{formData.country}</option>
            )}
            {countries.map((country) => (
              <option key={country.id} value={country.country_name}>
                {country.country_name}
              </option>
            ))}
          </select>
          {countriesLoading && <p className="text-gray-500 text-xs mt-1">Loading countries...</p>}
          {countriesError && (
            <p className="text-red-500 text-xs mt-1">Unable to load countries. Please refresh and try again.</p>
          )}
          {errors.country && <p className="text-red-500 text-xs mt-1">{errors.country}</p>}
        </div>

        {/* Street Address Line 1 */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            Street Address Line 1 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="streetAddress1"
            value={formData.streetAddress1 || ''}
            onChange={handleChange}
            placeholder="Enter your street address"
            className={`w-full px-4 py-3 bg-gray-100 border rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors ${
              errors.streetAddress1 ? 'border-red-500' : 'border-gray-200'
            }`}
          />
          {errors.streetAddress1 && (
            <p className="text-red-500 text-xs mt-1">{errors.streetAddress1}</p>
          )}
        </div>

        {/* Street Address Line 2 (Optional) */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            Street Address Line 2 (Optional)
          </label>
          <input
            type="text"
            name="streetAddress2"
            value={formData.streetAddress2 || ''}
            onChange={handleChange}
            placeholder="Apartment, suite, etc. (Optional)"
            className="w-full px-4 py-3 bg-gray-100 border border-gray-200 rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors"
          />
        </div>

        {/* City / Town */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            City / Town <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="city"
            value={formData.city || ''}
            onChange={handleChange}
            placeholder="Enter your city"
            className={`w-full px-4 py-3 bg-gray-100 border rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors ${
              errors.city ? 'border-red-500' : 'border-gray-200'
            }`}
          />
          {errors.city && <p className="text-red-500 text-xs mt-1">{errors.city}</p>}
        </div>

        {/* State / Province / Region */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            State / Province / Region <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="state"
            value={formData.state || ''}
            onChange={handleChange}
            placeholder="Enter your state or province"
            className={`w-full px-4 py-3 bg-gray-100 border rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors ${
              errors.state ? 'border-red-500' : 'border-gray-200'
            }`}
          />
          {errors.state && <p className="text-red-500 text-xs mt-1">{errors.state}</p>}
        </div>

        {/* Postal / ZIP Code */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            Postal / ZIP Code <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="postalCode"
            value={formData.postalCode || ''}
            onChange={handleChange}
            placeholder="e.g., 110001"
            className={`w-full px-4 py-3 bg-gray-100 border rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors ${
              errors.postalCode ? 'border-red-500' : 'border-gray-200'
            }`}
          />
          {errors.postalCode && <p className="text-red-500 text-xs mt-1">{errors.postalCode}</p>}
        </div>

        {/* Address Type */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-3">Address Type</label>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="addressType"
                value="home"
                checked={formData.addressType === 'home'}
                onChange={handleChange}
                className="w-4 h-4 text-amber-600 cursor-pointer"
              />
              <Home size={16} className="text-gray-500" />
              <span className="text-sm text-gray-600">Home</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="addressType"
                value="work"
                checked={formData.addressType === 'work'}
                onChange={handleChange}
                className="w-4 h-4 text-amber-600 cursor-pointer"
              />
              <Briefcase size={16} className="text-gray-500" />
              <span className="text-sm text-gray-600">Work</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="addressType"
                value="other"
                checked={formData.addressType === 'other'}
                onChange={handleChange}
                className="w-4 h-4 text-amber-600 cursor-pointer"
              />
              <MoreHorizontal size={16} className="text-gray-500" />
              <span className="text-sm text-gray-600">Other</span>
            </label>
          </div>
        </div>

        {/* Delivery Notes */}
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-2">
            Delivery Notes (Optional)
          </label>
          <textarea
            name="deliveryNotes"
            value={formData.deliveryNotes || ''}
            onChange={handleChange}
            placeholder="Leave at door / call before delivery / gate code / etc."
            rows={3}
            className="w-full px-4 py-3 bg-gray-100 border border-gray-200 rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors resize-none"
          />
        </div>

        {/* Default Address Checkbox */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="isDefault"
            checked={formData.isDefault || false}
            onChange={handleChange}
            className="w-4 h-4 text-amber-600 cursor-pointer"
          />
          <span className="text-sm text-gray-600">Set as default address</span>
        </label>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-4 mt-8">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-3 bg-gray-100 text-gray-900 rounded-lg border border-gray-200 hover:bg-gray-100 transition-colors font-medium"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex-1 px-4 py-3 bg-amber-500 text-black rounded-lg hover:bg-yellow-400 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? 'Saving...' : initialData ? 'Update Address' : 'Add Address'}
        </button>
      </div>
    </form>
  );
};

export default AddressForm;
