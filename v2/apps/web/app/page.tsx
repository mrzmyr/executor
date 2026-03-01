import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import ControlPlanePageContent from "./page-content";
import { isWorkosEnabled } from "../lib/workos";

const Page = async () => {
  const authEnabled = isWorkosEnabled();

  if (authEnabled) {
    const { user } = await withAuth();

    if (!user) {
      redirect("/sign-in");
    }

    return (
      <ControlPlanePageContent
        authEnabled
        initialWorkspaceId={`ws_${user.id}`}
      />
    );
  }

  return (
    <ControlPlanePageContent
      authEnabled={false}
      initialWorkspaceId="ws_demo"
    />
  );
};

export default Page;
