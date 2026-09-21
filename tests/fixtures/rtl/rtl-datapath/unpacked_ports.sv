// Unpacked array ports: `logic [31:0] x[2]` is 32 bits over 2 elements, so the
// signal on the wire is 64 bits. Ports that report only the packed width read as
// a width mismatch against their own net.
module unpacked_child (
  input  logic        clk_i,
  input  logic [31:0] imd_q_i[2],
  output logic [31:0] imd_d_o[2]
);
  always_comb begin
    imd_d_o[0] = imd_q_i[1];
    imd_d_o[1] = imd_q_i[0];
  end
endmodule

module unpacked_ports (
  input  logic        clk_i,
  input  logic [31:0] imd_q_i[2],
  output logic [31:0] imd_d_o[2]
);
  unpacked_child u_child (
    .clk_i   (clk_i),
    .imd_q_i (imd_q_i),
    .imd_d_o (imd_d_o)
  );
endmodule
