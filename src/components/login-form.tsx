import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginForm({ errorMessage }: { errorMessage: string | null }) {
  return (
    <form action="/api/auth/sign-in" method="post" className="mt-8 space-y-5">
      <div className="space-y-2">
        <label className="text-sm font-medium text-ink" htmlFor="email">Email address</label>
        <Input autoComplete="username" id="email" name="email" type="email" required maxLength={254} placeholder="you@example.com" />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium text-ink" htmlFor="password">Password</label>
        <Input autoComplete="current-password" id="password" name="password" type="password" required maxLength={1024} />
      </div>
      <div aria-live="polite" className="min-h-5 text-sm text-red-700" role="status">
        {errorMessage}
      </div>
      <Button className="w-full justify-center" type="submit">Sign in to workspace</Button>
    </form>
  );
}
