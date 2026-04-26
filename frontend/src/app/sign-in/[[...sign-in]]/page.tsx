import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-600 blur-[120px] rounded-full" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-cyan-500 blur-[120px] rounded-full" />
      </div>
      <SignIn
        appearance={{
          variables: {
            colorPrimary: '#7c3aed',
            colorBackground: '#0a0a0f',
            colorText: '#f9fafb',
            colorTextSecondary: '#9ca3af',
            colorInputBackground: 'rgba(255,255,255,0.05)',
            colorInputText: '#f9fafb',
            borderRadius: '0.75rem',
          },
        }}
      />
    </div>
  );
}
