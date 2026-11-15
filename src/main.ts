import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.min.css";
import "./styles.css";

import { mountConfiguredApplication } from "./bootstrap";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("应用挂载点不存在");

void mountConfiguredApplication(root);
