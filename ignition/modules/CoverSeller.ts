// This module deploys the CoverSellerV1 contract using Hardhat Ignition.
// Learn more at https://hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

exports.CoverSellerModule = buildModule("CoverSellerModule", (m) => {
    // Get parameters that must be provided during deployment
    const owner = m.getParameter("owner", m.getAccount(0));
    const admin = m.getParameter("admin", m.getAccount(1));
    const collector = m.getParameter("collector", m.getAccount(2));

    // Deploy the contract
    const coverSellerLogic = m.contract("CoverSeller", [], { id: "coverSellerLogic" });

    let coverSellerProxy = m.contract(
        "ERC1967Proxy",
        [
            coverSellerLogic,
            m.encodeFunctionCall(coverSellerLogic, "initialize", [owner, admin, collector]),
        ],
        { id: "coverSellerProxy" }
    );
    const coverSeller = m.contractAt("CoverSeller", coverSellerProxy);


    return { coverSeller };
});

// module.exports = exports.CoverSellerV1Module;
